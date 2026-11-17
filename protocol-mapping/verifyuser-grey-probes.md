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

## 9. 2026-11-17 反汇编结论（Linux ELF 4.1.13，radare2）——§8 方案修订

完整证据见 [verifyuser-protocol-spec.md §10](verifyuser-protocol-spec.md)。要点：

1. **transport 假设排除 [硬]**：verifyuser 端点 glue `0x69280a0` 与 newsync glue `0x61e52a0` 同构（栈描述符 {cgi, path} + 通用任务对象 {cgi@+0xc, path@+0x18, request@+0x88, response@+0x128}），共用同一提交链（`0x76be360 → 0x69200e0 → 0x69280a0 → 0x6927dc0 → 0x6927d10`）。glue 描述符里没有 longlink command 字段——**`longlink:<cmd>` 候选遍历不再必要**（第 2 步可跳过）。
2. **opcode/scene 硬证据**：官方填充函数 `0x69200e0` 写 **opcode(field2)=1、scene(field3)=1**，且载重字段是 **field4（repeated VerifyUser，元素 field1=字符串）**，不是 field9（VerifyUserInfo{encryptusername,ticket}）。本文件 §2 的形状矩阵与 §4 的 transport 探针都是围绕被推翻的模板设计的。
3. **-2 重解读**：读类 CGI 正常 + 同一提交机制 → -2 与 handler 参数校验失败（形状/取值错）兼容，不必再归因网关或会话权限。

**修订后的下一步**：按 spec §10.5 的 `baseline2` 矩阵重测（opcode=1 / scene=1 / field4 载重），在 `wechat-protocol/src/verify_user.rs` 加 `WX_VERIFY_PROBE=baseline2` 系列开关；ret=0 或出现非 -2 业务码即收敛。

## 9. 官方形状探针矩阵（2026-11-17，mac 端，WX_VERIFY_PROBE=official*）

> 环境：mac 本机 hub（debug 构建 74b87cd+official 探针），账号 `account-self-a`
>（wxid-self-a / 昵称A），申请人 `wxid-applicant`（昵称B，scene=15，
> 2026-11-17T02:16 到达）。每轮前清 `friend-request-handled:*` marker 后经
> `POST /friend-requests/{user}/accept` 触发。

**前置发现**：新登录后 `verify-user` gate 默认关闭——accept 直接被
`contact_accept_gate_closed` 拦截（HTTP 500 operation_failed，operation 未创建）。
必须先 `POST /contacts/verify-user/gate {"enabled":true}`。

**业务应答突破**：官方形状（opcode=1/scene=1/field4 VerifyUser）首次拿到**业务层应答**
`serviceCode=-2, message="Invalid argument"`（含 \n\x10 前缀），不再是信封层 0B 空载荷——
服务器已解析 body，「网关层拒绝」解读正式撤销（与 §10.5 一致）。

| 探针 | VerifyUser 形状 | 结果 |
|---|---|---|
| official1 | f1=encrypt_username | -2 Invalid argument（业务层） |
| official2 | f1=申请人 username | -2 IA |
| official3 | f1=username + f2=ticket | -2 IA |
| official4 | f1=username + f14={1:ticket} | -2 IA |
| official6 | f1=username + f14={1:biz{1:1,2:ticket,3:scene15,4:encryptusername}} | -2 IA |
| official8 | official6 但外层 scene=-1（会话记录里的值） | -2 IA |
| official9 | official6 + field7=[1] + f14={1:ticket}（双 f14，形状有瑕疵） | -2 IA |
| official10 | official6 但 f1=own username（wxid-self-a） | -2 IA |

**结论**：形状族（opcode=1/scene=1/field4 VerifyUser）已被服务器路由+解析，
「Invalid argument」稳定出现说明**某个具体参数值/字段仍不对**。剩余候选：
1. biz 对象（0x38B 六字段 {int,string,int,string,int,string}）的真实字段号与内容
   （本轮假设 1..=6 顺序、内容 {1, ticket, scene15, encryptusername}——未验证）
2. VerifyUser 其余字段（f4/f5/f6/f7/f9/f12/f15/f16/f17）官方 accept 是否填了
3. field7 repeated int32 的真实取值
4. BaseRequest.task（task1/task12 探针未跑完）
5. ticket 编码：申请 XML 的 ticket 带 `v2_ticket@str=` 前缀，verifyuser 是否要求
   解码后的值（候选：剥离前缀 / base64 解码）
6. gate/rate-limit/operation 链路本身已工作正常（HTTP 202 + operation 轮询）

探针实现：`wechat-protocol/src/verify_user.rs` encoded() 的 `official*` 分支；
core 侧 `VerifyUserAcceptRequest` 新增 `username` 字段（申请人 wxid，官方 fill arg3 候选）。

### 9.1 第二轮矩阵（2026-11-17 下午，official11-23，SKBuiltinBuffer_t 修正 + opcode 交叉）

环境同 §9（账号重新扫码登录一次：官方探测高频重启 daemon 触发服务器端会话失效
`needs_login: no_usable_saved_trust`）。每轮前清 `friend-request-handled:*`、
`verify-user-attempt:*`、`verify-user-last`。

| 探针 | 形状 | 结果 |
|---|---|---|
| official11 | official6 + biz.f2 ticket 剥 `v2_ticket@str=` 前缀 | -2 IA（业务层） |
| official12 | official6 + BaseRequest.task=1 | -2 IA |
| official13 | official6 + BaseRequest.task=12 | -2 IA |
| official14 | opcode=3/scene=15 + official6 形状 | 信封 -2 空 payload |
| official15 | biz 补全六字段 {5:0, 6:username} | -2 IA |
| official16 | opcode=1 + scene=15（请求 scene 回显） | 信封 -2 |
| official17 | opcode=1/scene=1/f7 + f14={1:len,2:biz}（SKB 修正） | 首测信封 -2；复测 -2 IA |
| official18 | official17 + ticket 剥前缀 | -2 IA |
| official19 | opcode=3/scene=15 + SKB 修正形状 | 信封 -2（复现 official14） |
| official20 | opcode=3/scene=15 + field9={f1:ticket, f2:encryptusername} | -2 IA |
| official21 | opcode=3/scene=15 + field9={f1:username, f2:ticket} | 信封 -2 |
| official22 | opcode=3/scene=15 + field9={f1:encryptusername, f2:ticket 剥前缀} | 信封 -2 |
| official23 | opcode=3/scene=15 + field9={f1:ticket 剥前缀, f2:encryptusername} | 信封 -2 |

**探针实现新增**：BaseRequest.task 覆盖（official12/13 + 修复 grey task1/task12 死代码——旧实现
task 变量从未传入 base_request）；SKBuiltinBuffer_t f14 形状（official17-19）；field9 排列
（official20-23）。

**本轮结论**：
1. **信封层 -2 有随机抖动**：official17 同形状两次结果不同（信封/业务层），单次信封拒不能
   定罪形状；opcode=3+field4 两次复现信封拒是稳定信号。
2. **稳定路由规则**：opcode=1/scene=1 → handler（业务层 IA）；scene=15+opcode=1 → 信封拒；
   opcode=3+field4 → 信封拒（稳定）；opcode=3+field9 → handler（grey 旧模板 + official20 均业务层 IA）。
3. **f14 = SKBuiltinBuffer_t{1:iLen, 2:pBuffer} 形状可进 handler**——服务器端接受 {1:varint}
   （旧 {1:bytes} 形状也进 handler，服务器对 f14 的 parse 两种都容了或服务器 proto 与 4.1.13
   客户端存在分歧——无法从应答区分）。
4. **handler 级 IA 覆盖全部形状组合**：biz 内容/字段映射、ticket 编码、BaseRequest.task、
   f7 值、f9 排列均未收敛 → 问题不再是静态可穷举的形状，而是「值」或「accept 构造点未定位」。
5. spec §10.6 定性修正后，**0x69200e0 是主动加好友（ContactHeadView）流程**，accept 的官方
   构造点仍缺失；opcode 在官方代码里是运行时变量（无 =3 立即数写点）。

**下一步候选**（按价值排序）：
1. 抓官方 4.x 客户端真实 accept 包（Windows/mac 端 MTEM/代理，操作一次同意好友）——直接
   破案，所有形状假设一次性验证；
2. Linux 侧继续静态：从 `0x76be360` 续体的回调对象（r14+0x30/0x58/0x70 string 字段）反查
   业务层调用者（发起点函数），或搜 oplog/`VerifyUserOpLog` 相关构造点；
3. 服务器端 -2 IA 的「值」假设验证：对同一申请**先 getcontact 拉取申请人资料再 accept**、
   或 scene=15（扫码）特判材料。

### 9.2 Frida 动态取证（2026-11-17 晚，10.7.1.29 Linux 微信客户端，hook 在线）

**环境**：10.7.1.29（Ubuntu 22.04，桌面会话）运行微信 Linux 4.1.x 客户端
（`~/reverse/wechat-root/opt/wechat/wechat`，181,208,032 B——与 §10.6 反汇编同一文件，全部 VA 偏移直接可用）。
Frida 17.26.4（`python3 -m pip install --user frida-tools`，yama ptrace_scope=1 下用 **spawn 模式**）。
脚本：`~/reverse/frida-accept/{hook_verifyuser.js, drive_verifyuser.py}`；启动
`nohup python3 -u ~/reverse/frida-accept/drive_verifyuser.py 7200 >/tmp/drive.log 2>&1 &`（微信自动恢复登录态）。

**Hook 点**：fill `0x69200e0`（params 六字段）、CopyFrom `0x7f26170`（预填 VerifyUserRequest 对象 0xA0 dump）、
VerifyUserRequest::serialize `0x7f25a50`（hasbits@+0x98）、glue `0x69280a0`（提交确认）。

**决定性结果 [硬]**：测试小号在客户端点「同意」（Verify Now）触发 verifyuser 全链
（glue-submit → copyfrom → serialize），dump 出的 VerifyUserRequest 对象（vptr = base+0xa9c5478，
VerifyUserRequest 确认）字段：

```
+0x10  opcode  = 3      ← accept
+0x14  scene   = 1      ← 不是 15！申请来源「手机号搜索」
+0x18  field4  data ptr（repeated VerifyUser）
+0x20  field4  size  = 1（一个 VerifyUser 元素）
+0x58  field9  = 空          ← VerifyUserInfo 载体被官方 accept 完全弃用
+0x98  hasbits = 0x437
```

**§9.1 矩阵失败的归因闭合**：
- official14/19（opcode=3+**scene=15**+field4）→ 信封层拒：**opcode=3 handler 校验 scene=1**；
- official1-18（opcode=**1**）→ 业务层 IA：opcode=1 是「主动申请」语义（ContactHeadView 流程），
  handler 按申请校验 accept 材料 → Invalid argument；
- grey 旧模板（opcode=3/scene=15/**field9**）→ IA：scene 与载体双错；
- **官方 accept 形状 = opcode=3 + scene=1 + field4=[VerifyUser{...}]，field9 不用**——§10.6 的
  「Windows opcode accept=3 [推] 重新有效」正式成立，但 scene 必须写 1（官方运行时值）。

**待补（下一轮，hook 升级版已就位）**：VerifyUser 元素内部（f1 username 值、f14 SKB{iLen, pBuffer}
内容 hex、0x88 对象字节）+ CopyFrom 调用栈回溯（定位 accept 构造函数 VA）。升级 hook 已实现
`dumpVerifyUser()`（解引用 field4 元素→读 f1/f14/0x88 字节）并部署，等下一轮触发。

## 11. 链路追踪实装（2026-11-17，Linux 端）

`WX_PROTOCOL_TRACE=1` 后 stderr 逐阶段输出 `wx-trace <ts> <stage> k=v…`：

| stage | 内容 |
|---|---|
| `verifyuser-encode` | 探针名 / input_scene / 实际编码 shape（字段号+类型+长度） |
| `rpc-begin` | cgi / path / host / 请求 shape |
| `pack` | 包头全字段：client_version、uin、cookie_len、key_version、cert_version、checksum、compression、encryption、notice_id、sequence、plain/body 长度 |
| `mmtls-reply` | 响应长度 + 32B hex 头 |
| `envelope` | return_code / reply-cgi / encryption / compression / cookie_len / payload 32B hex 头 / 两个长度字段 |
| `plain` | 解密后明文 shape |
| `longlink-send` | longlink 通道的 cgi/command/sequence |

只打长度、编码与密文 hex 头，不含 cookie、密钥与 ticket 明文。每一轮探针把 trace 与
operation 审计事件对齐即可定位拒绝发生在哪一层（encode → pack → mmtls → envelope → handler）。
