---
'@agent-wechat/shared': patch
---

Add a per-account offline mode switch for UI debugging and hot reload:

- `POST /v1/accounts/{a}/offline` (login scope) turns offline mode on or off. Enabling disconnects the live connection immediately; disabling does not reconnect by itself.
- While offline mode is on, the daemon admits no WeChat server request: login attempts, syncs, metadata and avatar refreshes, media transfers and downloads, contact-request submissions, and text/share/media sends are all refused with `offline_mode_enabled`, and the reconnect loop skips the account. Every read keeps coming from the local cache.
- The account status now reports `offlineMode`.
- `wx accounts offline` shows the current state; `wx accounts offline --on` / `--off` toggle it.
- The hub UI's account panel shows the offline state and can toggle it.
