# 上游功能合并后的 UI 缺口清单

> 背景：本次把上游 `thisnick/agent-wechat` 的好友申请、联系人搜索与同意链路合并进后端
> （`wechat-protocol` / `wechat-core` / `wechat-api` / `wx`），UI 保留我们重构后的
> `wechat-ui`。下面记录后端已就绪、但 `wechat-ui` 还没有对应界面的功能，供后续补 UI。
>
> 更新：2026-11-19

## 已完成的部分

- 好友申请列表与同意：`ContactsPanel` 的「新的朋友」改为读取
  `GET /contact-requests?direction=incoming`，同意/删除走
  `POST /contact-requests/{id}/accept` 与 `DELETE /contact-requests/{id}`，
  携带列表返回的 `version` 作为前置条件。
- 聊天气泡里的好友申请卡片：同样按 `peerId` 解析出 canonical request 后再调用上述接口。
- 角标：`refreshFriendRequestCount` 使用 `pendingIncomingCount`。
- 旧接口 `friend-requests/*`、`contacts/verify-user/*` 仍保留在 daemon 中，但
  `wechat-ui` 已不再调用（它们的请求编码是旧探针实现，未通过验证）。

## 待补 UI

### 1. 远程找人 + 发送好友申请（高优先级）

- 现状：`ContactSearchDialog` 只搜索**本地已同步通讯录**，没有微信服务器发现能力，
  也没有发送好友申请的入口。
- 后端已就绪：
  - `POST /search/contacts`（body `{query}`）→ `NativeContactSearch`
    （`displayName`、`recipientRef`、`expiresAt`、`request`）。
  - `POST /contact-requests`（`recipientRef`、`message`，可选 `privacy`）→ 操作。
- 上游参考：`packages/client-ui/src/contact-requests.tsx` 的 OmniSearch /
  discovery 分支与请求面板。
- 目标位置：`wechat-ui/src/components/ContactSearchDialog.tsx` 增加
  「在微信中搜索」区块；`wechat-ui/src/api.ts` 已有 `discoverContact` 可用，
  还需补 `sendContactRequest`。

### 2. 独立的好友申请收件箱（中优先级）

- 现状：申请只作为通讯录侧栏的一小段（最多 50 条 incoming），没有独立页面、
  双向历史、搜索与分页。
- 后端已就绪：`GET /contact-requests` 支持 `direction`、`actionable`、
  `search`、`limit`、`cursor`，返回 `history`、`attention`、
  `pendingIncomingCount`。
- 上游参考：`contact-requests.tsx`（约 1200 行：列表、详情、历史、未读）。
- 目标位置：`wechat-ui` 新增导航入口（AppRail 或通讯录页签）。

### 3. 联系人详情卡（中优先级）

- 现状：没有联系人详情界面，无法改备注、无法设置「仅聊天 / 不看 ta / 不让 ta 看」。
- 后端已就绪：
  - `GET /contacts/{id}` 返回 `privacy`、`privacyVersion`、`remarkPending`、
    `privacyUnavailable`。
  - `PATCH /contacts/{id}`（`privacy` 或 `remark` + `expectedVersion`）→ 操作。
  - 隐私读取辅助在 `wechat-core/src/contact_privacy_state.rs`，暂未暴露路由。
- 上游参考：`packages/client-ui/src/contact-editor.ts`（约 520 行）与
  `contact-privacy.ts`（约 200 行）。
- 目标位置：`wechat-ui/src/components/ContactsPanel.tsx` 行点击菜单 →
  详情面板/抽屉。

### 4. 删除联系人（中优先级）

- 现状：无入口。
- 后端已就绪：`DELETE /contacts/{id}`（保留聊天记录）。
- 上游参考：`contact-requests.tsx` 的 `removeContact` 选择项。
- 目标位置：联系人详情卡的危险操作区。

### 5. 统一搜索（低优先级）

- 现状：只有会话内消息搜索与通讯录本地搜索，没有 ⌘K 全局搜索。
- 上游参考：`packages/client-ui/src/main.tsx` 的 `omniScope` 与
  `contact-requests.tsx` 的 OmniSearch、`history-search.ts`。
- 目标位置：`wechat-ui/src/components/` 新增全局搜索面板。

### 6. 隐私读取路由（低优先级）

- `wechat-core/src/contact_privacy_state.rs` 已从上游移植，当前以
  `#![allow(dead_code)]` 保留；等联系人详情卡落地时一起接 API。

## 明确未合并的上游内容

- sticker 相关 store/core/api/UI（我们暂无 sticker 功能）。
- 上游 `packages/client-ui` 的整体 UI（按约定使用我们的 `wechat-ui`）。
- 上游 i18n 目录与 CI 调整。
