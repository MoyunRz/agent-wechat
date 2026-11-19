---
'@agent-wechat/agent-wechat': patch
---

QR-code sign-in no longer assumes the slot the code was issued on. When a scan completes, the daemon routes the fresh credentials to the slot that already holds that WeChat identity — matched from the slot's saved credentials or its bound official profile identity, so a logged-out account returns to its original slot with its alias and chat history intact. The routing holds the target slot's account lock, tears down any leftover session before installing, and authorizes against that slot's own logout epoch. A slot that already runs the same identity online reports `identity_in_use` instead of double-binding, login attempts report the routed slot as `adoptedAccountId` (absent when the attempt slot is kept), and a brand-new identity keeps the attempt slot exactly as before.
