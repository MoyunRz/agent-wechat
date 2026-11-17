---
'@agent-wechat/shared': patch
---

Cache whole-table catalog rows per profile generation so paged contacts, groups and members listings stop re-reading the entire table for every page. A 2 800-contact directory that previously spent ~0.9 s per page now serves continuation pages in ~25 ms when the profile is unchanged, while message and thread listings keep their existing behavior because they embed store-side state a generation bump does not cover.
