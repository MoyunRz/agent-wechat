---
'@agent-wechat/agent-wechat': patch
---

Forward contact edits to the account's live client again. The bound upstream did
not expose the raw contact RPC, so accepting a friend request, saving a remark or
relationship privacy, and removing a contact never reached WeChat; the operation
was held as an unknown outcome instead.

Report that unknown outcome immediately. The UI now treats `needs_review` as a
final state, re-reads the friend-request inbox and the open request so a
completed accept shows its real status, and tells the user the result is
uncertain. Before, a friend-request action stayed on "处理中" for the full
two-minute poll before any message appeared, and a known-failed state could
invite a blind retry of an operation that may already have happened.
