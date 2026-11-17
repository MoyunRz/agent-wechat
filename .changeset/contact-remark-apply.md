---
'@agent-wechat/shared': patch
---

Apply controlled contact fields when the update carries their value: a GetContact reply includes the remark together with the field-control mask that previously made the projection skip it, so remarks never reached the local contact table and every chat showed nicknames instead of the remark set on the phone. The mask now only preserves local values for sparse updates where the field is absent, and explicit remark/nickname bytes from the authoritative per-contact read are written as before.
