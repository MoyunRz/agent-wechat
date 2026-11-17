---
'@agent-wechat/shared': patch
---

Render app-message subtype 21 cards (WeChat Sport rankings and similar service-account cards) by projecting the card title as the message body. These messages previously fell through the app-message parser and surfaced as an "[应用消息]" placeholder with no content. Only the title is exposed; other card fields stay unparsed pending verified evidence.
