---
'@agent-wechat/shared': patch
---

Tighten outgoing pacing and cache locality after a risk-control event:

- Sends to one chat are paced at least 30 seconds apart, and one send whose outcome lands in `needs_review` opens a one-hour send circuit for the whole account (text, share and media sends).
- Contact-request accept/decline pacing is raised to minute-level (60 seconds between submissions, daily cap unchanged), and a failed submission - the empty-reply-envelope case - immediately opens a one-hour circuit that stops the whole batch.
- Automatic downloads no longer fetch the Original variant of images and videos in parallel with the compressed copy; originals stay available on explicit request.
- Metadata refreshes are paced per target (contact/group 60s, members 30s, avatar 300s), full contact/group catalog rounds are capped at three per day, and a failed round backs off exponentially (30s doubling to a 10-minute ceiling).
- Avatar refreshes serve the locally cached copy for six hours instead of re-fetching the CDN on every call.
