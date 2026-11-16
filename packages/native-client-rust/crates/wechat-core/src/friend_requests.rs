//! Inbound contact requests (message type 37) and their acceptance.
//!
//! The list derives from stored type-37 messages in the fmessage thread,
//! deduplicated per applicant keeping the newest. Request material (the
//! encryptusername and its ticket) never leaves the sealed profile database:
//! API responses carry names and the greeting only, and acceptance reads the
//! material from the stored message by applicant username.
use super::*;
use anyhow::ensure;

/// Maximum stored request XML accepted for parsing (mirrors the projection
/// guard in sync_projection).
const MAX_REQUEST_XML: usize = 1024 * 1024;
/// 4.x stores request fields in <msg> attributes; children are the legacy
/// layout. Ticket lengths follow the core acceptance limits.
const MAX_TICKET: usize = 16384;
const MAX_ENCRYPT_USERNAME: usize = 512;

#[derive(Clone, Debug)]
pub(crate) struct RequestMaterial {
    pub from_username: String,
    pub from_nickname: Option<String>,
    pub greeting: Option<String>,
    pub encrypt_username: String,
    pub ticket: String,
    pub scene: Option<u32>,
    pub created_at: i64,
    pub message_id: String,
}

fn supplied(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && !value.contains('\0')
        && !value.chars().any(char::is_control)
}

/// Read one request field: attributes first (4.x layout), children fallback
/// (legacy layout). Empty attribute values fall through to the child text.
fn request_field<'a>(root: roxmltree::Node<'a, 'a>, name: &str) -> Option<&'a str> {
    if let Some(value) = root.attribute(name) {
        if !value.is_empty() {
            return Some(value);
        }
    }
    root.children()
        .filter(|n| n.is_element() && n.tag_name().name() == name)
        .filter_map(|n| n.text())
        .find(|t| !t.trim().is_empty())
}

/// Parse one stored type-37 message body into request material. Returns None
/// for bodies without a usable request payload rather than failing the list.
pub(crate) fn parse_request_material(
    message_id: &str,
    created_at: i64,
    content: &str,
) -> Option<RequestMaterial> {
    if content.len() > MAX_REQUEST_XML
        || content.to_ascii_uppercase().contains("<!DOCTYPE")
        || content.to_ascii_uppercase().contains("<!ENTITY")
    {
        return None;
    }
    let doc = roxmltree::Document::parse(content).ok()?;
    let root = doc.root_element();
    if root.tag_name().name() != "msg" || root.tag_name().namespace().is_some() {
        return None;
    }
    let from_username = request_field(root, "fromusername")?.trim().to_owned();
    let encrypt_username = request_field(root, "encryptusername")?.trim().to_owned();
    let ticket = request_field(root, "ticket")?.trim().to_owned();
    if !supplied(&from_username, 512) || !identity_ok(&from_username) {
        return None;
    }
    if !supplied(&encrypt_username, MAX_ENCRYPT_USERNAME)
        || !supplied(&ticket, MAX_TICKET)
    {
        return None;
    }
    let scene = request_field(root, "scene")
        .and_then(|value| value.trim().parse::<u32>().ok());
    let from_nickname = request_field(root, "fromnickname")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let greeting = request_field(root, "content")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    Some(RequestMaterial {
        from_username,
        from_nickname,
        greeting,
        encrypt_username,
        ticket,
        scene,
        created_at,
        message_id: message_id.to_owned(),
    })
}

fn identity_ok(username: &str) -> bool {
    // Mirrors the projection identity guard loosely: printable names only.
    !username.contains('\0') && !username.chars().any(char::is_control)
}

impl Core {
    pub(crate) fn handled_marker_key(message_id: &str) -> String {
        format!("friend-request-handled:{message_id}")
    }

    /// Attach the request status to one normalized type-37 message card:
    /// handled markers win, otherwise a confirmed contact means accepted.
    pub(crate) fn enrich_friend_request_status(&self, account: &str, value: &mut Value) -> Result<()> {
        if value["type"].as_i64() != Some(37) {
            return Ok(());
        }
        let message_id = value["id"].as_str().unwrap_or_default().to_owned();
        let Some(request) = value.get_mut("friendRequest").filter(|v| v.is_object()) else {
            return Ok(());
        };
        let username = request["fromUsername"].as_str().unwrap_or_default().to_owned();
        let status = if let Some(handled) = self
            .store
            .runtime(account, &Self::handled_marker_key(&message_id))?
        {
            if handled == b"accepted" { "accepted" } else { "declined" }
        }
        else {
            let confirmed = if username.is_empty() {
                false
            }
            else {
                let reader = self.profile_reader_owned(account)?;
                self.confirmed_contact(&reader, &username)?
            };
            if confirmed { "accepted" } else { "pending" }
        };
        request["status"] = json!(status);
        Ok(())
    }

    fn stored_request_messages(
        &self,
        account: &str,
    ) -> Result<Vec<wechat_profile::Message>> {
        let reader = self.profile_reader_owned(account)?;
        let own = self.profile_username(account)?;
        let page = reader.messages(&wechat_profile::MessageQuery {
            chat: Some("fmessage".into()),
            own_username: own,
            limit: Some(200),
            message_type: Some(37),
            ..Default::default()
        })?;
        Ok(page.items)
    }

    /// Newest stored request per applicant. The reader returns newest first;
    /// the first row per applicant wins regardless of order by comparing times.
    fn latest_requests(
        &self,
        account: &str,
    ) -> Result<BTreeMap<String, RequestMaterial>> {
        let mut latest: BTreeMap<String, RequestMaterial> = BTreeMap::new();
        for message in self.stored_request_messages(account)? {
            let Some(text) = message.content.text.as_deref() else {
                continue;
            };
            let Some(material) = parse_request_material(
                &crate::profile::message_id(&message.id)?,
                message.create_time,
                text,
            ) else {
                continue;
            };
            let entry = latest
                .entry(material.from_username.clone())
                .or_insert_with(|| material.clone());
            if (material.created_at, material.message_id.clone())
                > (entry.created_at, entry.message_id.clone())
            {
                *entry = material;
            }
        }
        Ok(latest)
    }

    /// Whether the applicant is already a confirmed contact (local_type set by
    /// a ModContact). Message-derived minimal rows keep local_type NULL while
    /// a request is still pending, so this distinguishes the two states.
    fn confirmed_contact(
        &self,
        reader: &wechat_profile::ProfileReader,
        username: &str,
    ) -> Result<bool> {
        let mut query = wechat_profile::ListQuery {
            limit: Some(200),
            ..Default::default()
        };
        loop {
            let page = reader.contacts(&query)?;
            if let Some(found) = page.items.iter().find(|c| c.username == username) {
                return Ok(found.local_type.is_some());
            }
            match page.next_cursor.clone() {
                Some(cursor) => query.cursor = Some(cursor),
                None => return Ok(false),
            }
        }
    }

    /// Derive the "new friends" list: newest request per applicant, requests
    /// from confirmed contacts filtered out. Material fields are omitted.
    pub fn friend_requests(&self, account: &str) -> Result<Value> {
        self.account_state(account)?;
        let latest = self.latest_requests(account)?;
        let reader = self.profile_reader_owned(account)?;
        let mut items = Vec::new();
        for (username, material) in latest {
            if self
                .store
                .runtime(account, &Self::handled_marker_key(&material.message_id))?
                .is_some()
            {
                continue;
            }
            if self.confirmed_contact(&reader, &username)? {
                continue;
            }
            items.push(json!({
                "id": material.message_id,
                "username": material.from_username,
                "nickname": material.from_nickname,
                "alias": null,
                "greeting": material.greeting,
                "avatar": null,
                "hasScene": material.scene.is_some(),
                "scene": material.scene,
                "createdAt": chrono::DateTime::from_timestamp(material.created_at, 0)
                    .map(|d| d.to_rfc3339()),
            }));
        }
        items.sort_by(|a, b| b["createdAt"].as_str().cmp(&a["createdAt"].as_str()));
        Ok(json!({"items": items}))
    }

    /// Dry-run acceptance check for one applicant's newest stored request.
    pub fn friend_request_preflight(&self, account: &str, username: &str) -> Result<Value> {
        ensure!(
            !username.is_empty() && username.len() <= 64 && identity_ok(username),
            "invalid_contact_request_username"
        );
        self.account_state(account)?;
        let latest = self.latest_requests(account)?;
        let Some(material) = latest.get(username) else {
            return Ok(json!({
                "username": username,
                "found": false,
                "ready": false,
                "dryRun": true,
                "blocking": ["not_pending"],
            }));
        };
        if self
            .store
            .runtime(account, &Self::handled_marker_key(&material.message_id))?
            .is_some()
        {
            return Ok(json!({
                "username": username,
                "found": false,
                "ready": false,
                "dryRun": true,
                "blocking": ["already_handled"],
            }));
        }
        let reader = self.profile_reader_owned(account)?;
        let already = self.confirmed_contact(&reader, username)?;
        let mut blocking = Vec::new();
        if already {
            blocking.push("already_friends");
        }
        let gate_open = self.store
            .runtime(account, "verify-user-gate")?
            .is_some_and(|value| value == b"1");
        if !gate_open {
            blocking.push("gate_closed");
        }
        if material.scene.is_none() {
            blocking.push("missing_scene");
        }
        let ready = blocking.is_empty();
        Ok(json!({
            "username": username,
            "found": true,
            "ready": ready,
            "dryRun": true,
            "scene": material.scene,
            "nickname": material.from_nickname,
            "greeting": material.greeting,
            "hasV3": !material.encrypt_username.is_empty(),
            "hasV4": !material.ticket.is_empty(),
            "blocking": blocking,
        }))
    }

    /// Accept one applicant's newest stored request. Material comes from the
    /// stored message, never from the caller; the core acceptance keeps its
    /// gate, rate limit and idempotency semantics.
    pub async fn accept_friend_request(
        self: &Arc<Self>,
        account: &str,
        username: &str,
        key: &str,
    ) -> Result<Operation> {
        self.act_on_friend_request(account, username, key, "accepted")
            .await
    }

    /// Decline one applicant's newest stored request under the same
    /// gate/rate-limit semantics; the request is marked handled either way.
    pub async fn decline_friend_request(
        self: &Arc<Self>,
        account: &str,
        username: &str,
        key: &str,
    ) -> Result<Operation> {
        self.act_on_friend_request(account, username, key, "declined")
            .await
    }

    async fn act_on_friend_request(
        self: &Arc<Self>,
        account: &str,
        username: &str,
        key: &str,
        action: &'static str,
    ) -> Result<Operation> {
        ensure!(
            !username.is_empty() && username.len() <= 64 && identity_ok(username),
            "invalid_contact_request_username"
        );
        let latest = self.latest_requests(account)?;
        let material = latest
            .get(username)
            .context("contact_request_not_found")?;
        let scene = material.scene.context("contact_request_missing_scene")?;
        let marker = Self::handled_marker_key(&material.message_id);
        let operation = if action == "accepted" {
            self.accept_contact_request(
                account,
                &material.encrypt_username,
                &material.ticket,
                scene,
                key,
            )
            .await?
        } else {
            self.decline_contact_request(
                account,
                &material.encrypt_username,
                &material.ticket,
                scene,
                key,
            )
            .await?
        };
        // Submission accepted by the gate: hide the request from the list
        // regardless of the signed outcome, which the operation carries.
        self.store
            .put_runtime(account, &marker, action.as_bytes())?;
        Ok(operation)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn material_xml(attributes: bool) -> String {
        let fields = [
            ("fromusername", "wxid_applicant"),
            ("fromnickname", "申请人"),
            ("encryptusername", "V2_encrypt::abc"),
            ("ticket", "v2_ticket@str=strange"),
            ("scene", "14"),
            ("content", "我是 let"),
        ];
        if attributes {
            let joined = fields
                .iter()
                .map(|(k, v)| format!("{k}=\"{v}\""))
                .collect::<Vec<_>>()
                .join(" ");
            format!("<msg {joined}></msg>")
        } else {
            let joined = fields
                .iter()
                .map(|(k, v)| format!("<{k}>{v}</{k}>"))
                .collect::<Vec<_>>()
                .join("");
            format!("<msg>{joined}</msg>")
        }
    }

    #[test]
    fn parses_attribute_and_child_layouts_and_rejects_junk() {
        for xml in [material_xml(true), material_xml(false)] {
            let material = parse_request_material("m1", 100, &xml).unwrap();
            assert_eq!(material.from_username, "wxid_applicant");
            assert_eq!(material.from_nickname.as_deref(), Some("申请人"));
            assert_eq!(material.encrypt_username, "V2_encrypt::abc");
            assert_eq!(material.ticket, "v2_ticket@str=strange");
            assert_eq!(material.scene, Some(14));
            assert_eq!(material.greeting.as_deref(), Some("我是 let"));
        }
        assert!(parse_request_material("m1", 100, "<other/>").is_none());
        assert!(parse_request_material("m1", 100, "<msg></msg>").is_none());
        assert!(parse_request_material("m1", 100, "<msg ticket=\"t\"></msg>").is_none());
        assert!(parse_request_material("m1", 100, "<!DOCTYPE msg><msg/>").is_none());
    }

    #[test]
    fn scene_is_optional_but_acceptance_requires_it() {
        let xml = material_xml(true).replace("scene=\"14\"", "scene=\"\"");
        let material = parse_request_material("m1", 100, &xml).unwrap();
        assert_eq!(material.scene, None);
    }
}
