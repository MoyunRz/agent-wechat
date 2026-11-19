---
'@agent-wechat/agent-wechat': patch
---

Resolve WeChat hosts through a bounded built-in resolver instead of depending on the machine's system DNS alone. The system lookup still runs first and healthy answers are cached, but when it stalls, the daemon queries public resolvers over TCP 53 — a path that survives the UDP packet loss and DHCP DNS overwrites that used to leave accounts stuck in "reconnecting".
