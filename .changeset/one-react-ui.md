---
'@agent-wechat/desktop': minor
'@agent-wechat/agent-wechat': minor
---

The desktop app and the daemon's `/ui/` page now share one React chat interface. The two separate interfaces are gone: the account picker, conversations, messages and media, contacts, the AI panel and the settings screens all render from the same bundle, so a fix or visual change appears in both places. The daemon keeps serving the page at `/ui/` with its one-click sign-in link, and the desktop app bundles the same build.

The desktop app also gained what only the browser page had before: conversation search, the contacts view, the AI chat panel, and the appearance settings for theme, bubble colours and font size.

Not carried over yet: group creation and group management, which the old desktop UI had. They are planned as a follow-up; the account still manages groups from the phone until then.
