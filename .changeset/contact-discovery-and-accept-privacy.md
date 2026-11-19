---
"@agent-wechat/cli": minor
"@agent-wechat/rust-crates": minor
"@agent-wechat/shared": minor
---

Allow discovery matches without a verification ticket. Such a match now returns `recipientRef: null` instead of failing the response, since the contract required a string and the whole search returned `invalid_server_response`; a null reference means that match cannot send a request. Accepting a friend request now takes an optional initial `privacy` value through the HTTP contract, the CLI and the SDK, and the desktop app's friend-request dialogs let you choose that privacy before accepting. Friend requests whose stored profile columns are NULL are readable, and writing one back keeps an empty column empty.
