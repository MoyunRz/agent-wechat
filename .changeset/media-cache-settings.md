---
'@agent-wechat/agent-wechat': patch
---

Add media cache controls to the UI settings panel: proactive caching of incoming images, stickers, files, videos and voice (each on by default, stored as account settings) and a cache cleanup action that removes this account's derived cache files by age (24 hours, 3, 7, 14 or 30 days, or everything). The cleanup only deletes regenerable cache bytes; chat history and received messages stay untouched.
