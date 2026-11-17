//! Accept one inbound contact request through the supported contact operation.
//!
//! The verifyuser endpoint multiplexes contact-request actions by opcode.
//! Request field2 carries the opcode, field3 the request scene, and repeated
//! field9 entries carry one encryptusername/ticket pair each; both subfields
//! are required strings. The response's BaseResponse retains the signed
//! service code and message. Opcode and scene semantics follow the request
//! that carried the pair and are confirmed during staged rollout.
use crate::{protobuf as p, AccountState, NativeClient};
use anyhow::{ensure, Result};
use serde::{Deserialize, Serialize};

const CGI: u16 = 137;
const PATH: &str = "/cgi-bin/micromsg-bin/verifyuser";
const MAX_IDENTITY_BYTES: usize = 512;
const MAX_TICKET_BYTES: usize = 16384;

/// Opcode accepting the contact request carried in field9.
pub const ACCEPT_OPCODE: u32 = 3;
/// Opcode declining the contact request carried in field9. Candidate from the
/// protocol spec {2=request, 3=accept, 4=decline}; the signed service reply
/// validates it during rollout.
pub const DECLINE_OPCODE: u32 = 4;

/// One contact request to act on, exactly as received with that request.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VerifyUserAcceptRequest {
    /// Encryptusername supplied with the inbound contact request.
    pub encrypt_username: String,
    /// Ticket supplied with the inbound contact request.
    pub ticket: String,
    /// Scene value supplied with the inbound contact request.
    pub scene: u32,
    /// Applicant username (wxid) supplied with the inbound contact request.
    /// The official fill code puts this string into the VerifyUser entry.
    #[serde(default)]
    pub username: String,
}

/// The reply for one contact-request action, retaining the signed code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifyUserAcceptReply {
    /// Signed service code; zero means accepted.
    pub service_code: i32,
    /// Service-supplied message, when present.
    pub message: Option<String>,
}

impl VerifyUserAcceptReply {
    /// Whether the service accepted the action.
    pub fn accepted(&self) -> bool {
        self.service_code == 0
    }
}

fn supplied_text(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && !value.contains('\0')
        && !value.chars().any(char::is_control)
}

/// Encode one contact-request action (accept or decline) with the account's
/// BaseRequest. The wire layout is identical; only the opcode differs.
pub fn encoded(
    state: &AccountState,
    input: &VerifyUserAcceptRequest,
    opcode: u32,
) -> Result<Vec<u8>> {
    state.validate()?;
    ensure!(
        input.encrypt_username.len() <= MAX_IDENTITY_BYTES
            && supplied_text(&input.encrypt_username, MAX_IDENTITY_BYTES),
        "Invalid contact-request encryptusername"
    );
    ensure!(
        supplied_text(&input.ticket, MAX_TICKET_BYTES),
        "Invalid contact-request ticket"
    );
    let probe = std::env::var("WX_VERIFY_PROBE").unwrap_or_default();
    // BaseRequest.task override: official12/official13 carry the task values
    // noted in the spec under the official shape; task1/task12 apply the same
    // override to the grey-scale field9 shape.
    let task = match probe.as_str() {
        "official12" | "task1" => 1,
        "official13" | "task12" => 12,
        _ => 0,
    };
    let base = p::bytes(1, &crate::wire::base_request(&state.device, state.uin, task)?);
    let entry = p::message(&[
        p::bytes(1, input.encrypt_username.as_bytes()),
        p::bytes(2, input.ticket.as_bytes()),
    ])?;
    // Official-shape probes per verifyuser-protocol-spec.md §10.4/§10.5: the
    // official fill code writes opcode=1, scene=1, and carries the applicant
    // material as repeated field4 VerifyUser{field1=username} entries — not
    // the field9 VerifyUserInfo{encryptusername,ticket} template.
    if probe.starts_with("official") {
        let identity = match probe.as_str() {
            // official10: the fill function's arg3 could be the logged-in
            // account's own username instead of the applicant's.
            "official10" => state.own_username.as_str(),
            "official1" => input.encrypt_username.as_str(),
            _ => input.username.as_str(),
        };
        let identity = if supplied_text(identity, MAX_IDENTITY_BYTES) {
            identity
        } else {
            &input.encrypt_username
        };
        let mut vu_fields = vec![p::bytes(1, identity.as_bytes())];
        if probe == "official3" {
            vu_fields.push(p::bytes(2, input.ticket.as_bytes()));
        }
        if probe == "official4" || probe == "official9" {
            vu_fields.push(p::bytes(
                14,
                &p::message(&[p::bytes(1, input.ticket.as_bytes())])?,
            ));
        }
        if matches!(
            probe.as_str(),
            "official6" | "official7" | "official8" | "official9" | "official11" | "official14"
            | "official15" | "official17" | "official18" | "official19"
        ) {
            // VerifyUser.f14 is the shared two-string message; its first string
            // carries the serialized six-field business object that the official
            // fill code serializes from the request params. Field numbers are the
            // working hypothesis (1..=6 in {int,string,int,string,int,string}
            // order).
            // official11/official18: the stored ticket carries the
            // "v2_ticket@str=" envelope prefix; the business entry may expect
            // the decoded inner value.
            let biz_ticket = if probe == "official11" || probe == "official18" {
                let stripped = input
                    .ticket
                    .strip_prefix("v2_ticket@str=")
                    .unwrap_or(&input.ticket);
                stripped.strip_suffix('@').unwrap_or(stripped)
            } else {
                input.ticket.as_str()
            };
            let mut biz_fields = vec![
                p::uint(1, 1),
                p::bytes(2, biz_ticket.as_bytes()),
                p::uint(3, u64::from(input.scene)),
                p::bytes(4, input.encrypt_username.as_bytes()),
            ];
            // official15: complete the six-field object with the two trailing
            // {int,string} entries (params+0x50/+0x58); the int is guessed 0
            // and the string the applicant username.
            if probe == "official15" {
                biz_fields.push(p::uint(5, 0));
                biz_fields.push(p::bytes(6, identity.as_bytes()));
            }
            let biz = p::message(&biz_fields)?;
            // official17/18: f14 is micromsg.SKBuiltinBuffer_t{iLen=1,
            // pBuffer=2} per the Linux ELF class serialize 0x7ba67f0 — not a
            // two-string message. The serialized business object carries its
            // own byte length in field1.
            if probe == "official17" || probe == "official18" || probe == "official19" {
                vu_fields.push(p::bytes(
                    14,
                    &p::message(&[p::uint(1, biz.len() as u64), p::bytes(2, &biz)])?,
                ));
            } else {
                vu_fields.push(p::bytes(
                    14,
                    &p::message(&[p::bytes(1, &biz)])?,
                ));
            }
        }
        let vu = p::message(&vu_fields)?;
        // official14 crosses the official field4 shape with the capture-side
        // opcode/scene pair (3/15): the session capture shows the submitted
        // request carrying 3/15 while the fill code writes 1/1, so the hub
        // layer may overwrite both literals before submission.
        let opcode_field = if probe == "official14" || probe == "official19" { 3 } else { 1 };
        let mut fields = vec![base, p::uint(2, opcode_field), p::bytes(4, &vu)];
        // official8 records the scene value noted in the Windows-side session
        // log (-1) instead of the +1 literal seen in the Linux fill code.
        match probe.as_str() {
            "official8" => fields.push(p::int32(3, -1)),
            // official16: keep the fill opcode=1 but echo the request's scene.
            "official14" | "official16" | "official19" => fields.push(p::uint(3, 15)),
            _ => fields.push(p::uint(3, 1)),
        }
        if probe == "official5"
            || probe == "official9"
            || probe == "official11"
            || probe == "official14"
            || probe == "official17"
            || probe == "official18"
            || probe == "official19"
        {
            fields.push(p::uint(7, 1));
        }
        return p::message(&fields);
    }
    // official20-23: opcode=3 accept variants over the field9 VerifyUserInfo
    // carrier (the opcode=3 handler rejects field4 shapes at the envelope
    // layer, and VerifyUserInfo only has the two string fields). Each mode
    // permutes the ticket/identity placement and the ticket envelope prefix.
    if matches!(probe.as_str(), "official20" | "official21" | "official22" | "official23") {
        let stripped_ticket = {
            let stripped = input
                .ticket
                .strip_prefix("v2_ticket@str=")
                .unwrap_or(&input.ticket);
            stripped.strip_suffix('@').unwrap_or(stripped)
        };
        let (first, second) = match probe.as_str() {
            "official20" => (input.ticket.as_str(), input.encrypt_username.as_str()),
            "official21" => (input.username.as_str(), input.ticket.as_str()),
            "official22" => (input.encrypt_username.as_str(), stripped_ticket),
            _ => (stripped_ticket, input.encrypt_username.as_str()),
        };
        let entry = p::message(&[p::bytes(1, first.as_bytes()), p::bytes(2, second.as_bytes())])?;
        return p::message(&[
            base,
            p::uint(2, 3),
            p::uint(3, 15),
            p::bytes(9, &entry),
        ]);
    }
    // Grey-scale probe: WX_VERIFY_PROBE switches request shapes while hunting
    // the envelope -2 rejection. Modes: no-payload (frame fields only),
    // op1/op2 (override opcode), field4 (pair into field 4 instead of 9),
    // task1/task12 (BaseRequest task), scene1/scene14 (override scene).
    let opcode = match probe.as_str() {
        "op1" => 1,
        "op2" => 2,
        _ => opcode,
    };
    let scene = match probe.as_str() {
        "scene1" => 1,
        "scene14" => 14,
        _ => input.scene,
    };
    let mut fields = vec![
        base,
        p::uint(2, u64::from(opcode)),
        p::uint(3, u64::from(scene)),
    ];
    if probe != "no-payload" {
        if probe == "field4" {
            fields.push(p::bytes(4, &entry));
        } else {
            fields.push(p::bytes(9, &entry));
        }
    }
    p::message(&fields)
}

/// Encode one contact-request acceptance with the account's BaseRequest.
pub fn request(state: &AccountState, input: &VerifyUserAcceptRequest) -> Result<Vec<u8>> {
    encoded(state, input, ACCEPT_OPCODE)
}

fn optional_text(fields: &[p::Field], number: u32, max: usize) -> Result<Option<String>> {
    p::optional_data(fields, number)?
        .map(|bytes| {
            ensure!(bytes.len() <= max, "verifyuser field exceeds limit");
            let text = std::str::from_utf8(bytes)?;
            ensure!(!text.contains('\0'), "Invalid verifyuser text");
            Ok(text.to_owned())
        })
        .transpose()
}

/// Decode an authenticated verifyuser reply, preserving signed rejections.
pub fn decode_response(bytes: &[u8]) -> Result<VerifyUserAcceptReply> {
    let fields = p::decode(bytes)?;
    let base = p::decode(p::data(&fields, 1)?)?;
    let raw = p::scalar(&base, 1)?;
    let code = raw as u32 as i32;
    ensure!(
        raw <= u64::from(u32::MAX) || (code < 0 && raw == code as i64 as u64),
        "Invalid verifyuser service code"
    );
    let message = optional_text(&base, 2, MAX_IDENTITY_BYTES)?;
    Ok(VerifyUserAcceptReply {
        service_code: code,
        message,
    })
}

impl NativeClient {
    /// Submit exactly one contact-request acceptance without renewal, retry or
    /// login fallback. An error can follow submission and must be treated as an
    /// unknown outcome.
    pub(crate) fn verify_user_accept_snapshot(
        &self,
        state: &mut AccountState,
        input: &VerifyUserAcceptRequest,
    ) -> Result<VerifyUserAcceptReply> {
        self.verify_user_action_snapshot(state, input, ACCEPT_OPCODE)
    }

    /// Submit exactly one contact-request decline under the same snapshot
    /// semantics as acceptance.
    pub(crate) fn verify_user_decline_snapshot(
        &self,
        state: &mut AccountState,
        input: &VerifyUserAcceptRequest,
    ) -> Result<VerifyUserAcceptReply> {
        self.verify_user_action_snapshot(state, input, DECLINE_OPCODE)
    }

    fn verify_user_action_snapshot(
        &self,
        state: &mut AccountState,
        input: &VerifyUserAcceptRequest,
        opcode: u32,
    ) -> Result<VerifyUserAcceptReply> {
        let request = zeroize::Zeroizing::new(encoded(state, input, opcode)?);
        // Grey-scale cross probe: swap the CGI number, the URL path, or send
        // via a dedicated longlink connection (WX_VERIFY_CROSS=longlink:<cmd>)
        // to distinguish a gateway-routing rejection from a request-body one.
        let probe = std::env::var("WX_VERIFY_CROSS").unwrap_or_default();
        let reply = if let Some(command) = probe.strip_prefix("longlink:") {
            let command: u32 = command.parse().unwrap_or(u32::from(CGI));
            let mut connection = crate::push::Connection::open(
                state,
                self.options.timeout,
                self.options.receive_budget,
            )?;
            connection.rpc(state, CGI, command, &request, || Ok(()))?
        } else {
            let (cgi, path) = match probe.as_str() {
                "cgi137-path-getcontact" => (CGI, "/cgi-bin/micromsg-bin/getcontact"),
                "cgi182-path-verifyuser" => (182, PATH),
                _ => (CGI, PATH),
            };
            self.authenticated_rpc(state, cgi, path, &request)?
        };
        decode_response(&reply)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> AccountState {
        AccountState {
            schema: 1,
            device: crate::DeviceProfile {
                device_id: b"0123456789abcdef".to_vec(),
                device_type: "UnifiedPCLinux x86_64".into(),
                client_version: -227271398,
            },
            uin: 42,
            own_username: "synthetic_user".into(),
            cookie: vec![],
            session_key: vec![1; 16],
            request_key: vec![2; 24],
            response_key: vec![3; 24],
            auto_auth_key: vec![4; 16],
            key_info: vec![],
            database_password: vec![],
            auth_snapshot: Default::default(),
            long_host: "long.weixin.qq.com".into(),
            short_host: "short.weixin.qq.com".into(),
        }
    }

    fn input() -> VerifyUserAcceptRequest {
        VerifyUserAcceptRequest {
            encrypt_username: "V2_example".into(),
            ticket: "ticket".into(),
            scene: 14,
            username: "wxid_applicant".into(),
        }
    }

    #[test]
    fn request_matches_the_accept_wire_layout() {
        // Field 1 = BaseRequest, field 2 = opcode 3, field 3 = scene, field 9
        // = one encryptusername/ticket pair.
        let encoded = request(&state(), &input()).unwrap();
        let fields = p::decode(&encoded).unwrap();
        assert_eq!(fields.len(), 4);
        let base = p::decode(p::data(&fields, 1).unwrap()).unwrap();
        assert_eq!(p::scalar(&base, 2).unwrap(), 42);
        assert_eq!(p::scalar(&fields, 2).unwrap(), 3);
        assert_eq!(p::scalar(&fields, 3).unwrap(), 14);
        let entry = p::decode(p::data(&fields, 9).unwrap()).unwrap();
        assert_eq!(p::data(&entry, 1).unwrap(), b"V2_example");
        assert_eq!(p::data(&entry, 2).unwrap(), b"ticket");
    }

    #[test]
    fn request_rejects_invalid_identities_tickets_and_oversized_values() {
        let mut empty_identity = input();
        empty_identity.encrypt_username = String::new();
        assert!(request(&state(), &empty_identity).is_err());
        for value in ["", "a\0b", "a\nb", &"x".repeat(MAX_IDENTITY_BYTES + 1)] {
            let mut bad = input();
            bad.encrypt_username = value.into();
            assert!(request(&state(), &bad).is_err());
        }
        for value in ["", "a\0b", &"x".repeat(MAX_TICKET_BYTES + 1)] {
            let mut bad = input();
            bad.ticket = value.into();
            assert!(request(&state(), &bad).is_err());
        }
        let mut invalid = state();
        invalid.uin = 0;
        assert!(request(&invalid, &input()).is_err());
    }

    #[test]
    fn response_reads_service_code_and_message() {
        let bytes = p::message(&[p::bytes(
            1,
            &p::message(&[p::int32(1, 0), p::bytes(2, b"ok")]).unwrap(),
        )])
        .unwrap();
        let reply = decode_response(&bytes).unwrap();
        assert_eq!(reply.service_code, 0);
        assert_eq!(reply.message.as_deref(), Some("ok"));
        let minimal = decode_response(
            &p::message(&[p::bytes(1, &p::message(&[p::int32(1, 0)]).unwrap())]).unwrap(),
        )
        .unwrap();
        assert_eq!(minimal.service_code, 0);
        assert!(minimal.message.is_none());
    }

    #[test]
    fn response_preserves_signed_service_rejections() {
        for (code, expected) in [
            (-1, -1),
            (-13, -13),
            (i32::MIN, i32::MIN),
            (1, 1),
            (i32::MAX, i32::MAX),
        ] {
            let bytes =
                p::message(&[p::bytes(1, &p::message(&[p::int32(1, code)]).unwrap())]).unwrap();
            let reply = decode_response(&bytes).unwrap();
            assert_eq!(reply.service_code, expected);
            assert_eq!(reply.accepted(), code == 0);
        }
    }

    #[test]
    fn response_rejects_missing_ambiguous_or_malformed_base() {
        for bytes in [
            Vec::new(),
            p::uint(1, 0),
            p::bytes(2, &p::message(&[p::int32(1, 0)]).unwrap()),
            p::message(&[
                p::bytes(1, &p::message(&[p::int32(1, 0)]).unwrap()),
                p::bytes(1, &p::message(&[p::int32(1, 0)]).unwrap()),
            ])
            .unwrap(),
            p::bytes(1, &[]),
            p::message(&[p::bytes(1, &p::uint(1, 1u64 << 32))]).unwrap(),
            p::message(&[p::bytes(1, &p::message(&[p::bytes(2, &[0xff])]).unwrap())]).unwrap(),
        ] {
            assert!(decode_response(&bytes).is_err());
        }
    }
}
