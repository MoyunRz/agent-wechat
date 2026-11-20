---
'@agent-wechat/agent-wechat': patch
---

Create the friend-request database when the server has rotated the account's database password between logins. The cached profile keys still open every existing database, so the new general.db is keyed with the current password instead of wedging every incoming friend request behind the cross-database key check, and blocked sync batches now log the underlying projection error.
