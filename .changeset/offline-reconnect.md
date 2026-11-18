---
'@agent-wechat/agent-wechat': patch
---

Reconnect automatically from the saved login when offline mode is turned off, instead of keeping the account disconnected until a manual action. Accounts without saved login materials stay signed out as before, and the offline CLI help text now reflects the automatic reconnection.
