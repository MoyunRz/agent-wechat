---
'@agent-wechat/agent-wechat': minor
---

Add three fixed risk-control valves to autonomous WeChat replies, deliberately not user-configurable:

- Debounce: a thread only dispatches to the model after it has stayed quiet for 10 seconds, and the earlier messages of a burst join that turn as history — six rapid messages produce one reply, not six.
- Spacing: at least 30 seconds between automatic replies to the same thread; a thread answered moments ago defers instead of failing the daemon's send pacing.
- Circuit: one reply landing in `needs_review` pauses every automatic reply on the account for one hour (the daemon's send circuit enforces the same window on submissions).

Deferred messages keep their durable custody and retry on the next processing cycle; control commands bypass the valves.
