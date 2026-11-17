---
"@agent-wechat/rust-crates": patch
"@agent-wechat/agent-wechat": patch
---

Reading file and video attachments back from the official profile no longer fails on Windows. The hardlink cache reader built month-directory paths with the platform separator and then refused its own path, so a sent file was read back from the daemon's own copy instead of being released to the profile. Cache paths are now always built with forward slashes on every platform.
