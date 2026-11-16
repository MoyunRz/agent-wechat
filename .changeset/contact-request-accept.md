---
'@agent-wechat/shared': minor
---

Add contact-request acceptance behind a per-account gate: `POST /v1/accounts/{a}/contacts/verify-user/accept` submits one acceptance for the encryptusername, ticket and scene the inbound request carried, and `POST /v1/accounts/{a}/contacts/verify-user/gate` opens or closes the gate, which starts closed for every account. Submissions are rate limited, deduplicated by request material and audited without storing the ticket.
