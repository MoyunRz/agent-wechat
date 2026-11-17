//! Accepting one inbound contact request behind an explicit per-account gate.
//!
//! The gate defaults to closed; an operator enables it per account before any
//! submission is admitted. Every admitted submission keeps its own durable
//! record and the rate limit bounds how often submissions may run. Request
//! material (the encryptusername and its ticket) never enters events or
//! durable records; records carry lengths and hashes only.
use super::*;
use anyhow::ensure;
use wechat_protocol::VerifyUserAcceptRequest;

const GATE_KEY: &str = "verify-user-gate";
const LAST_KEY: &str = "verify-user-last";
const DAILY_LIMIT: u32 = 20;
const MIN_INTERVAL_SECS: u64 = 10;

/// One contact-request action multiplexed over the verifyuser endpoint.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ContactRequestAction {
    Accept,
    Decline,
}

impl ContactRequestAction {
    fn operation_kind(self) -> &'static str {
        match self {
            Self::Accept => "contact-request-accept",
            Self::Decline => "contact-request-decline",
        }
    }

    fn event_name(self) -> &'static str {
        match self {
            Self::Accept => "contact.request_accepted",
            Self::Decline => "contact.request_declined",
        }
    }

    fn failed_event_name(self) -> &'static str {
        match self {
            Self::Accept => "contact.request_accept_failed",
            Self::Decline => "contact.request_decline_failed",
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Accept => "accept",
            Self::Decline => "decline",
        }
    }
}

fn hash(value: &impl Serialize) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value)?)))
}

fn request_material_hash(encrypt_username: &str, ticket: &str, scene: u32) -> Result<String> {
    hash(&(encrypt_username, ticket, scene))
}

fn epoch_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

fn supplied_text(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && !value.contains('\0')
        && !value.chars().any(char::is_control)
}

fn validate_request_material(encrypt_username: &str, ticket: &str) -> Result<()> {
    ensure!(
        supplied_text(encrypt_username, 512),
        "invalid_contact_request_material"
    );
    ensure!(
        supplied_text(ticket, 16384),
        "invalid_contact_request_material"
    );
    Ok(())
}

impl Core {
    /// Open or close the per-account gate. Closed blocks every admission.
    pub fn set_contact_request_gate(&self, account: &str, enabled: bool) -> Result<()> {
        self.store.account(account)?;
        self.store
            .put_runtime(account, GATE_KEY, if enabled { b"1" } else { b"0" })?;
        self.store.append_event(
            account,
            "contact.accept_gate_changed",
            &json!({"enabled": enabled}),
        )?;
        Ok(())
    }

    fn gate_open(&self, account: &str) -> Result<bool> {
        Ok(self
            .store
            .runtime(account, GATE_KEY)?
            .is_some_and(|value| value == b"1"))
    }

    fn daily_count(&self, account: &str, day: u64) -> Result<u32> {
        let count_key = format!("verify-user-count:{day}");
        Ok(self
            .store
            .runtime(account, &count_key)?
            .and_then(|value| {
                std::str::from_utf8(&value)
                    .ok()
                    .and_then(|text| text.parse::<u32>().ok())
            })
            .unwrap_or_default())
    }

    fn rate_limit_check(&self, account: &str) -> Result<()> {
        let now = epoch_secs();
        if let Some(last) = self.store.runtime(account, LAST_KEY)? {
            let last = std::str::from_utf8(&last)?
                .parse::<u64>()
                .unwrap_or_default();
            ensure!(
                now.saturating_sub(last) >= MIN_INTERVAL_SECS,
                "contact_accept_rate_limited"
            );
        }
        ensure!(
            self.daily_count(account, now / 86_400)? < DAILY_LIMIT,
            "contact_accept_daily_limit_reached"
        );
        Ok(())
    }

    fn record_submission(&self, account: &str) -> Result<()> {
        let now = epoch_secs();
        self.store
            .put_runtime(account, LAST_KEY, now.to_string().as_bytes())?;
        let count_key = format!("verify-user-count:{}", now / 86_400);
        let count = self.daily_count(account, now / 86_400)?;
        self.store
            .put_runtime(account, &count_key, (count + 1).to_string().as_bytes())?;
        Ok(())
    }

    /// Submit one contact-request acceptance. The operation completes with the
    /// signed service outcome; a transport error can still follow submission
    /// and leaves the outcome unknown. Repeat submissions with the same
    /// material return the recorded outcome instead of resubmitting.
    pub async fn accept_contact_request(
        self: &Arc<Self>,
        account: &str,
        username: &str,
        encrypt_username: &str,
        ticket: &str,
        scene: u32,
        key: &str,
    ) -> Result<Operation> {
        self.submit_contact_request(
            account,
            username,
            encrypt_username,
            ticket,
            scene,
            key,
            ContactRequestAction::Accept,
        )
        .await
    }

    /// Submit one contact-request decline under the same gate, rate limit,
    /// idempotency and audit semantics as acceptance.
    pub async fn decline_contact_request(
        self: &Arc<Self>,
        account: &str,
        username: &str,
        encrypt_username: &str,
        ticket: &str,
        scene: u32,
        key: &str,
    ) -> Result<Operation> {
        self.submit_contact_request(
            account,
            username,
            encrypt_username,
            ticket,
            scene,
            key,
            ContactRequestAction::Decline,
        )
        .await
    }

    async fn submit_contact_request(
        self: &Arc<Self>,
        account: &str,
        username: &str,
        encrypt_username: &str,
        ticket: &str,
        scene: u32,
        key: &str,
        action: ContactRequestAction,
    ) -> Result<Operation> {
        if self.stopping.load(Ordering::Acquire) {
            bail!("service_stopping");
        }
        if key.is_empty() || key.len() > 200 {
            bail!("invalid_contact_accept_request");
        }
        validate_request_material(encrypt_username, ticket)?;
        self.store.account(account)?;
        ensure!(self.gate_open(account)?, "contact_accept_gate_closed");
        self.rate_limit_check(account)?;
        let core = self.clone();
        let username = username.to_owned();
        let encrypt_username = encrypt_username.to_owned();
        let ticket = ticket.to_owned();
        let worker_key = key.to_owned();
        let operation_kind = action.operation_kind();
        core.start_operation(account, operation_kind, move |core, account| async move {
            let guard = core.lock_account(&account).await?;
            let material = request_material_hash(&encrypt_username, &ticket, scene)?;
            let replay_key = format!("verify-user-attempt:{material}");
            if let Some(recorded) = core.store.runtime(&account, &replay_key)? {
                let recorded: Value = serde_json::from_slice(&recorded)?;
                return Ok(recorded["result"].clone());
            }
            ensure!(core.gate_open(&account)?, "contact_accept_gate_closed");
            core.rate_limit_check(&account)?;
            let input = VerifyUserAcceptRequest {
                encrypt_username: encrypt_username.clone(),
                ticket: ticket.clone(),
                scene,
                username: username.clone(),
            };
            let mut state = core.account_state(&account)?;
            let key_hash = hash(&worker_key)?;
            let rpc_core = core.clone();
            let rpc_account = account.clone();
            let action_for_rpc = action;
            let outcome = blocking(move || {
                let _guard = guard;
                rpc_core.native_request(&rpc_account, &mut state, |request| match action_for_rpc {
                    ContactRequestAction::Accept => request.verify_user_accept(&input),
                    ContactRequestAction::Decline => request.verify_user_decline(&input),
                })
            })
            .await;
            match outcome {
                Ok(reply) => {
                    core.record_submission(&account)?;
                    let attempt_record = serde_json::to_vec(&json!({
                        "result": {
                            "serviceCode": reply.service_code,
                            "accepted": reply.accepted(),
                            "message": reply.message,
                            "scene": scene,
                            "action": action.name(),
                        }
                    }))?;
                    core.store.put_runtime(
                        &account,
                        &format!("verify-user-attempt:{material}"),
                        &attempt_record,
                    )?;
                    core.store.append_event(
                        &account,
                        action.event_name(),
                        &json!({
                            "scene": scene,
                            "action": action.name(),
                            "serviceCode": reply.service_code,
                            "accepted": reply.accepted(),
                            "encryptUsernameLength": encrypt_username.len(),
                            "ticketLength": ticket.len(),
                            "materialHash": material,
                            "idempotencyKeyHash": key_hash,
                        }),
                    )?;
                    Ok(json!({
                        "serviceCode": reply.service_code,
                        "accepted": reply.accepted(),
                        "message": reply.message,
                    }))
                }
                Err(error) => {
                    // The signed outcome is unknown after a failed submission;
                    // keep the short root-cause text for diagnosis.
                    let text = error.to_string();
                    let mut end = text.len().min(500);
                    while end > 0 && !text.is_char_boundary(end) {
                        end -= 1;
                    }
                    core.store.append_event(
                        &account,
                        action.failed_event_name(),
                        &json!({
                            "scene": scene,
                            "action": action.name(),
                            "encryptUsernameLength": encrypt_username.len(),
                            "ticketLength": ticket.len(),
                            "materialHash": material,
                            "outcome": "unknown",
                            "error": &text[..end],
                        }),
                    )?;
                    Err(error)
                }
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn core() -> (Arc<Core>, tempfile::TempDir) {
        let temp = tempfile::tempdir().unwrap();
        let store = Arc::new(Store::open(&temp.path().join("data")).unwrap());
        store.create_account("one").unwrap();
        (Core::new(store, None).unwrap(), temp)
    }

    #[test]
    fn gate_defaults_to_closed_and_follows_explicit_changes() {
        let (core, _temp) = core();
        assert!(!core.gate_open("one").unwrap());
        core.set_contact_request_gate("one", true).unwrap();
        assert!(core.gate_open("one").unwrap());
        core.set_contact_request_gate("one", false).unwrap();
        assert!(!core.gate_open("one").unwrap());
        assert!(core.set_contact_request_gate("missing", true).is_err());
    }

    #[test]
    fn rate_limit_records_interval_and_daily_bounds() {
        let (core, _temp) = core();
        core.rate_limit_check("one").unwrap();
        core.record_submission("one").unwrap();
        // A second immediate submission hits the interval bound.
        assert!(core.rate_limit_check("one").is_err());
        // The daily counter recorded exactly one submission.
        let day = epoch_secs() / 86_400;
        let count = core
            .store
            .runtime("one", &format!("verify-user-count:{day}"))
            .unwrap()
            .unwrap();
        assert_eq!(std::str::from_utf8(&count).unwrap(), "1");
        // Twenty simulated submissions on one day exhaust the daily bound.
        core.store
            .put_runtime("one", &format!("verify-user-count:{day}"), b"19")
            .unwrap();
        core.store
            .put_runtime("one", LAST_KEY, (epoch_secs() - 60).to_string().as_bytes())
            .unwrap();
        core.rate_limit_check("one").unwrap();
        core.record_submission("one").unwrap();
        assert!(core.rate_limit_check("one").is_err());
    }

    #[test]
    fn request_material_validation_rejects_empty_control_and_oversized_values() {
        assert!(validate_request_material("V2_example", "ticket").is_ok());
        for (username, ticket) in [
            ("", "ticket"),
            ("a\0b", "ticket"),
            ("a\nb", "ticket"),
            (&*"x".repeat(513), "ticket"),
            ("V2_example", ""),
            ("V2_example", "a\0b"),
            ("V2_example", &*"x".repeat(16385)),
        ] {
            assert!(validate_request_material(username, ticket).is_err());
        }
    }

    #[tokio::test]
    async fn admission_requires_the_gate_a_valid_key_and_material() {
        let (core, _temp) = core();
        core.set_contact_request_gate("one", true).unwrap();
        let error = core
            .accept_contact_request("one", "wxid_applicant", "V2_example", "ticket", 14, "")
            .await
            .unwrap_err();
        assert!(error.to_string().contains("invalid_contact_accept_request"));
        let error = core
            .accept_contact_request("one", "wxid_applicant", "", "ticket", 14, "key")
            .await
            .unwrap_err();
        assert!(error
            .to_string()
            .contains("invalid_contact_request_material"));
    }
}
