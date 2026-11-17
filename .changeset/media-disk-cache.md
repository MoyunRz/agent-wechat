---
'@agent-wechat/agent-wechat': patch
---

Serve repeat reads of attachments and image previews from a derived on-disk cache. Decoded media bytes (decrypted profile files, SILK-converted voice, decoded WXGF previews, unsealed vault payloads) are kept under `<dataDir>/media-cache` and verified against the recorded asset hash before use, so scrolling history and reopening the UI no longer re-decode every attachment. The directory only holds regenerable bytes and can be deleted at any time; a size sweep keeps it bounded.
