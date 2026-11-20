# 上游功能合并后的 UI 缺口清单

> 背景：本次把上游 `thisnick/agent-wechat` 的好友申请、联系人搜索与同意链路合并进后端
> （`wechat-protocol` / `wechat-core` / `wechat-api` / `wx`），UI 保留我们重构后的
> `wechat-ui`。这里记录后端已就绪、UI 的对应情况，以及仍然存在的差异。
>
> 更新：2026-11-19

## 已完成的部分

- 好友申请列表与同意：`ContactsPanel` 的「新的朋友」读取
  `GET /contact-requests?direction=incoming`，同意/删除走
  `POST /contact-requests/{id}/accept` 与 `DELETE /contact-requests/{id}`，
  携带列表返回的 `version` 作为前置条件。
- 聊天气泡里的好友申请卡片：同样按 `peerId` 解析出 canonical request 后再调用上述接口。
- 角标：`refreshFriendRequestCount` 使用 `pendingIncomingCount`。
- 旧接口 `friend-requests/*`、`contacts/verify-user/*` 仍保留在 daemon 中，但
  `wechat-ui` 已不再调用（它们的请求编码是旧探针实现，未通过验证）。

## 本轮补齐的 UI（2026-11-19）

1. **远程找人 + 发送好友申请** — `ContactSearchDialog` 新增「在微信中搜索」入口，
   调用 `POST /search/contacts`；结果显示「聊天 / 去处理 / 已发送申请 / 添加好友」，
   发送表单包含验证消息与关系隐私（全部可见 / 仅聊天 + 两个朋友圈开关），
   提交 `POST /contact-requests` 并轮询操作结果。为避免每次输入都请求服务器，
   发现动作由按钮显式触发，而不是像上游那样自动防抖搜索。
2. **独立好友申请收件箱** — 新增 rail 入口与路由
   `#/hub/{account}/contacts/requests`（`ContactRequestsPanel`）：全部 / 收到的 / 已发送
   切换、服务端搜索、游标分页、详情（含申请记录）、通过 / 删除，
   操作成功后刷新通讯录与角标。通讯录不再内嵌申请列表，申请只在独立收件箱处理。
3. **联系人详情卡** — `ContactDetailCard`，从通讯录行尾的「联系人资料」按钮或
   会话详情的同名按钮打开：备注停止输入 800ms 后自动保存（失焦立即保存），
   关系隐私（全部可见 / 仅聊天 + 朋友圈开关）300ms 合并保存；两者都用
   `GET /contacts/{id}` 返回的 `privacyVersion` 作为 `expectedVersion`，
   `privacyPending` / `remarkPending` 有等待提示，版本冲突会重读后重试一次。
4. **删除联系人** — 详情卡危险区二次确认后调用 `DELETE /contacts/{id}`，
   保留聊天记录；成功后卡片保持打开并显示结果。
5. **统一搜索** — `GlobalSearchDialog`，`⌘K` / `Ctrl+K` 打开，
   分组显示联系人（`GET /contacts?search=`）、群聊（已加载会话）与
   全账号消息（`GET /messages?search=`）；↑↓ 选择、Enter 打开、Esc 关闭。

## 仍然存在的差异

- 全局搜索每个分组只取前 20 条，没有「加载更多」；上游的 OmniSearch 支持分组分页。
- 收件箱用 20 秒轮询刷新，未接 `friend_request.updated` / `contact.updated` 事件的即时失效。
- 发现搜索是显式按钮触发，上游是 OmniSearch 内自动防抖（600ms）请求。
- `contact_privacy_state.rs` 仍保留 `#![allow(dead_code)]`：`GET /contacts/{id}` 已返回
  `privacy` / `privacyVersion`，但复数快照路由（`NativeContactPrivacySnapshots`）未暴露，
  该辅助层要等批量读取需求出现再接。

## 明确未合并的上游内容

- sticker 相关 store/core/api/UI（我们暂无 sticker 功能）。
- 上游 `packages/client-ui` 的整体 UI（按约定使用我们的 `wechat-ui`）。
- 上游 i18n 目录与 CI 调整。
