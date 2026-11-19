# 扫码登录自动归位（槽位解耦）— 实施简报

> 目标（用户原话）：不要让二维码和卡槽关联，不要让用户选择登录账号，直接扫码登录，后台根据扫码成功后的登录信息自动分配原来的 profile 并更新认证信息——符合原生客户端行为。
> 本文件是交接简报，不入库提交。

## 1. 现状事实（已核实，直接采用）

### 账号/槽位模型
- registry：`registry.sqlite` accounts 表 `(id, storage_mode, profile_path UNIQUE, schema_compatibility, removed_at)`。**profile_path 有 UNIQUE 约束**；改表只能走新 migration（repo 规则）。
- 槽位数据：`<dataDir>/accounts/<id>/`（agent/control.sqlite = sidecar，profile/ = 官方格式 profile，如 `profile/xwechat_files/<wxid>_<hash>`）。
- 凭据： sealed account-state 存在各槽位自己的 vault 命名空间下（`account-state`），运行时键在 control.sqlite `runtime` 表（`desired` / `offline-mode` / `logged-out` / `validated-generation` / `logout-epoch`）。
- 账号别名：store 有 account_alias 读写（settings.rs `resolve_account` 附近）。
- 删除槽位：`wechat-store/src/account_removal.rs` 已有移除路径（含 runtime 写入拦截测试）。

### 扫码登录链路
- 入口：`POST /v1/accounts/{a}/login-attempts`（wechat-api/src/actions.rs；attempt 即 kind='login' 的 operation，result_json 记录 method/approved_login/profile 信息）。
- 轮询状态机：starting → awaiting_scan → awaiting_approval → succeeded / failed / rejected / expired / cancelled（UI LoginPanel 已映射）。
- 成功后凭据落盘路径：wechat-core/src/runtime.rs `persist_state(account, &state, …)` → sealed vault；成功即绑死在**发起 attempt 的那个槽位**上（这就是问题根源）。
- 关键守卫（repo 规则，不可绕过）：
  - identity admission / `check_state_profile`：槽位已有不同 wxid 的 profile 身份时，扫不同身份的码会 `login_failed`（已实证：Vane 旧槽位被 vecor 扫码拒绝）。
  - profile handoff 需要排他所有权（one writer per profile）；logout fence（logout-epoch）必须保留语义。

### UI 现状（wechat-ui/src）
- `App.vue`：`ensureAccount()`（~L1392，含“记住槽位优先，即使未登录”的止血逻辑——与本方案正交，可保留）；`selectSlot` / `loginWithNewSlot` / `LAST_ACCOUNT_KEY` / `pollLogin`（成功后 rememberAccountId）。
- `LoginPanel.vue`：有槽位选择模态框（pickerOpen/chooseSlot/chooseNewSlot，emits selectSlot/newSlot/loadSlots）——**本方案要求删除**。
- bootstrap 分支：`isSignedIn(account)`（= authenticated || savedLogin）。

## 2. 目标行为

1. 登录页只有“扫码登录”一个动作（删除槽位选择器与新槽位按钮）。
2. 扫码成功、拿到 own_username 后，daemon 自动归位：
   - 存在同身份的既有槽位 → 凭据/认证信息写入**该槽位**，attempt 结果返回归位后的 accountId；attempt 用过的临时槽位若为本 attempt 自动创建且无用户数据 → 移除。
   - 不存在同身份槽位 → 保留 attempt 槽位为新账号（现行为）。
   - 同身份已在另一槽位在线 → 明确拒绝（one writer per profile），不得双绑。
3. 失败/取消/过期路径不得建槽、不得改任何 profile。

## 3. 实施要点（建议路径）

- daemon（wechat-core/src/runtime.rs 登录完成处）：
  1. attempt 成功、own_username 已知时查目标槽位：遍历非 removed 账号，比对槽位已保存的 profile 身份（identity/profile_keys 或 runtime own-username）。
  2. 命中且 ≠ attempt 槽位：向目标槽位执行与正常登录相同的 persist 流程（目标 vault 命名空间、validated-generation 按 ownership_generation、logout-epoch 走正常登录同款清理），attempt result 增加归位结果；随后移除临时槽位（仅限本 attempt 自动创建的空槽）。
  3. attempt result 增加字段（如 `adoptedAccountId` / final accountId）→ 跑 `pnpm generate-types` 与 `pnpm interfaces` 并提交产物。
- UI：
  1. LoginPanel 删除槽位选择模态框与 newSlot 相关 emits/逻辑。
  2. pollLogin 成功分支：以 attempt 返回的最终 accountId 为准（rememberAccountId + refresh slots + 重新 bootstrap），不假设发起时的槽位。
  3. ensureAccount 止血逻辑保留（与归位正交）。
- 事件：归位发生时 append `account.updated`（含归位前后 accountId），attempt result 记录归位决策，禁止静默重复建槽。

## 4. 风险与红线

- 临时槽位移除只能用既有 removal 路径，且仅限“本 attempt 自动创建、无任何用户数据”的槽位；已有 profile 的槽位绝不可动。
- 目标槽位归位时必须维持排他所有权：确保该槽位无活动会话（worker/lease 停止）后再写凭据。
- registry `profile_path UNIQUE`：归位不改变目标槽位的 profile_path（凭据在 vault 按账号 id 命名空间，无需动 registry）。
- 不得绕过 identity admission / check_state_profile / logout fence。
- 同时多 attempt 并发：按 lock_account 串行化。

## 5. 验收清单（我方验收，全部满足才算通过）

1. **同身份归位**：Vane-493x（wxid_4w59nczk956322）登出后刷新扫码 → 直接进主界面，落在原槽位 id，别名/聊天记录保留，账号列表总数不变（无新槽）。
2. **新身份建槽**：用从未登录过的新微信号扫码 → 恰好新增 1 个槽位并进入主界面。
3. **双绑拒绝**：同身份已在 A 槽在线时在别处扫码 → 明确报错，A 槽状态不受影响。
4. **UI 简化**：登录页无槽位选择器/新建槽位入口；扫码成功自动落到正确界面，无需手动切账号。
5. **失败路径**：拒绝/取消/过期后账号列表与 profile 均无变化。
6. **回归**：离线开关（关→自动重连）、离线刷新保持登录、设置面板、缓存清理不受影响。
7. **门禁**：`cargo fmt --check` / clippy `-D warnings` / wechat-core+wechat-protocol 测试 / UI check+build 全绿；`pnpm generate-types`、`pnpm interfaces` 产物已提交；changeset 已添加。
8. **事件可审计**：归位发生时 events 有 account.updated（含归位决策），无静默槽位增殖。
