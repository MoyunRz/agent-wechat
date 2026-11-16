---
'@agent-wechat/shared': patch
---

Project the official `contact.local_type` bit for server-confirmed contacts: a ModContact command now writes 2 for group chats and 1 for every other saved contact, the contacts catalog exposes it as `localType`, and each contact-stream sync backfills rows that were projected before the bit existed from the retained batch payloads. Message-derived rows stay null until the contact stream confirms them, so contact lists can finally distinguish saved contacts from locally observed peers.
