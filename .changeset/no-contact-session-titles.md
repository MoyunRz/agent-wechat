---
'@agent-wechat/agent-wechat': patch
---

Use the official `SessionNoContactInfoTable` titles from session.db as thread display labels for peers without a contact row. WeChat stores a display title there for sessions whose peer has no contact entry (for example some customer-service conversations); these threads previously showed the raw peer ID and the UI fell back to a generic label. Contact remarks and nicknames keep priority; databases without the table are skipped.
