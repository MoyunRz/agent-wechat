---
'@agent-wechat/shared': minor
---

Store each WeChat account's OpenClaw configuration in the daemon registry, isolated per account:

- New registry migration (`openclaw_configs` table, schema version 5): every account keeps its own OpenClaw policy document (dmPolicy, allowFrom, groupPolicy, groupAllowFrom, groups, mediaMaxMb), and accounts without a stored copy fall back to the OpenClaw host config.
- `GET`/`PUT /v1/accounts/{a}/openclaw-config` read and write one account's document (`NativeOpenClawConfigRequest`); writes are admin-scoped, audited and limited to a 256 KiB JSON object; `config: null` clears the stored copy.
- The OpenClaw monitor now reads its account's stored document on every processing cycle and overrides only the policy keys — different WeChat users answer with different policies while the connection configuration stays in the host config.
- `wx accounts openclaw-config` shows the stored document, `--set-file FILE` replaces it and `--clear` removes it.
- The hub UI gains an OpenClaw tab: a management page for the per-account policy (DM/group policies, allowlists, mention requirement, media cap and advanced per-group JSON) with save and clear.
