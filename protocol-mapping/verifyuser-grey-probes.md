# verifyuser 灰度探针记录（信封 -2 排查）

> 2026-11-17。环境：本机 hub（`C:\Users\user\wx-hub\wx.exe`，release 构建），账号
> `account-self-b`（wxid-self-b），申请人 `wxid-self-a`
>（昵称A，通过手机号搜索，scene=15，encryptusername 210B / ticket 350B）。
> 探针开关：`WX_VERIFY_PROBE`（请求形状）与 `WX_VERIFY_CROSS`（cgi/path/longlink），
> 每轮清 `friend-request-handled:*` marker 后经 `POST /friend-requests/{user}/accept` 触发。

## 1. 失败形态

所有探针共用的失败签名（诊断增强后）：

```
contact.request_accept_failed { error: "Native envelope returned -2; reply-cgi=<n> encryption=0 compression=2 payload=0B head=, decrypt-failed", outcome: "unknown", scene: 15 }
```

- 信封层 `ret = -2`，服务器**正确回显 handler 对应的 cgi**，但没有生成加密业务应答
  （encryption=0、payload=0B）——请求在业务处理前被拒。
- 平行对照：同一会话内 `newsync`（CGI 138）、`getcontact`（CGI 182）等读类 CGI 均正常。

## 2. 请求形状矩阵（shortlink，全部 -2）

| 探针模式 | 变化 | 结果 |
|---|---|---|
| baseline | base + opcode=3 + scene + field9（VerifyUserInfo 对） | -2 |
| no-payload | 去掉 field9，只发 base+opcode+scene | -2 |
| op1 / op2 | opcode 覆盖为 1 / 2 | -2 |
| field4 | VerifyUserInfo 对改挂 field4 | -2 |
| task1 / task12、scene1 / scene14 | BaseRequest.task / scene 覆盖（账号登出前未跑完） | 未测 |

结论：**问题不在 protobuf 字段组合**。

## 3. cgi/path 交叉（shortlink）

| 探针 | pack 头 cgi | URL path | 响应回显 cgi | 结果 |
|---|---|---|---|---|
| cgi182-path-verifyuser | 182 | /verifyuser | **137** | -2 |
| cgi137-path-getcontact | 137 | /getcontact | **182** | -2 |

两个发现：

1. **服务器按 URL path 路由**，pack 头 cgi 号被忽略（响应信封回显 path 对应 handler 的 cgi）。
2. **两个不同 handler 对同一请求包都返回 -2 空载荷**——拒绝发生在包归属/会话层，而非
   某个 handler 的业务字段校验。

## 4. longlink 通道（待验证）

`push::Connection::rpc`（longlink）是通用请求通道：sync = cgi 138 → longlink command 121，
heartbeat = cgi 518 → command 238，响应 command = 请求 command + 96。verifyuser 的 longlink
command 号未知，候选从 137 试起（`WX_VERIFY_CROSS=longlink:<cmd>`）。

首轮尝试因账号会话失效未能执行（见 §5）。

## 5. 会话失效（次生发现）

凌晨 ~02:00-08:38 之间账号被微信服务端登出（hub 写入 `logged-out` fence，
`account_state()` 对 fenced 账号 bail `auth_required`）。-2（02:00 前）与登出时间连续，
**-2 可能是会话对 verifyuser 权限受限的信号**，也可能是无关的 CGI 特有行为——
重新登录后按 baseline → `longlink:137` → `longlink:121` 顺序复测。

## 6. 诊断增强（本轮代码）

1. `wechat-core/src/actions.rs`：operation 失败结果携带根因文本（截断 500B，协议层错误
   不含材料）。
2. `wechat-core/src/verify_user.rs`：失败事件带 `error` 字段。
3. `wechat-protocol/src/business.rs`：信封拒绝时尽力解密 payload 并提取业务
   BaseResponse errmsg，附带 `reply-cgi/encryption/compression/payload len/head hex`
   元数据。
4. `wechat-protocol/src/verify_user.rs`：`WX_VERIFY_PROBE` / `WX_VERIFY_CROSS` 灰度开关。
5. `push::Connection::rpc` 与 `NativeClient::options` 改为 `pub(crate)`，供探针走 longlink。

## 7. REA run3（并行）

Ghidra 12.1.4 会话（run3）成功完成（驱动脚本 traceValue 已修为递归查找，输出
`%TEMP%\wx-reverse\rea-session-run3\`）：13 个函数伪代码 + 6 个汇编 + 4 个 caller 候选。
确认了响应侧与消息结构，但**官方请求填充代码仍未定位**（业务代码经框架间接创建请求对象，
vtable/New/描述符构造均无直接调用者）。本地 PE 扫描（capstone）确认：
- Request vtable 0x189814448 仅被 protobuf 库内部引用（5 处，全在 0x183b1bxxx-0x183b22xxx）
- 端点描述符注册表位于 .rdata：verifyuser @ 0x1893ecae0-0x1893ecb00（getcontact @
  0x189242dd0-0x189242df0，结构平行）

## 8. 后续步骤

1. 重新登录（UI 扫码）
2. baseline 复测 → 若仍 -2，跑 `longlink:137` → `longlink:121` → 遍历 91/257 等候选
3. 若 longlink 全部失败，从反汇编定位官方「写操作 CGI」的 transport 选择逻辑
