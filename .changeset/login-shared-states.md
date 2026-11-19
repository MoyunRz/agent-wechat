---
'@agent-wechat/shared': patch
---

Add a framework-agnostic login-attempt state module (`login-states`) so the Vue (`wechat-ui`) and React (`client-ui`) login screens share one definition of terminal/failed/active/cancellable daemon states, QR visibility, expiry formatting, and the LAN-challenge hint. No behavior change; `client-ui` now consumes it, `wechat-ui` mirrors the sets with a sync note.
