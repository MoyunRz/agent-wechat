---
"@agent-wechat/cli": minor
"@agent-wechat/rust-crates": minor
"@agent-wechat/shared": patch
---

Merge upstream's verified contact-request path for friend requests, contact discovery and accepting requests.

- `wx contacts search <query>` discovers a WeChat ID on the server and returns an opaque `recipientRef`.
- `wx contacts requests list|get|send|accept|delete` lists, sends, accepts and locally deletes per-peer request conversations; accept sends the current `version` as a precondition.
- `wx contacts set` changes a friend's privacy settings or remark, `wx contacts remove` removes the relationship while keeping chat history, and `wx contacts list --all` includes non-contacts.
- Group-member listings return each member's `nickname` and saved `alias`, and member search also matches the name shown inside the group.
- HTTP routes: `POST /search/contacts`, `GET|POST /contact-requests`, `GET|DELETE /contact-requests/{id}`, `POST /contact-requests/{id}/accept`, `DELETE|PATCH /contacts/{id}` and `GET /contact-mutations/by-idempotency-key`.
- The UI's "new friends" list and message-card accept/decline actions now call the verified `/contact-requests` routes instead of the legacy `friend-requests` endpoints.
- The UI adds a friend-request inbox at `#/hub/{account}/contacts/requests`, a contact detail card for remarks, relationship privacy and removal, server discovery with a friend-request form, and ⌘K global search.

The legacy `friend-requests/*` and `contacts/verify-user/*` routes remain for compatibility but are no longer used by the UI; their request encoding predates the verified wire shape.
