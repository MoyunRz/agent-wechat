# verifyuser 协议规格（Windows 4.x Weixin.dll 静态分析结论）

> 依据：Ghidra 12.1.4 对 `Weixin.dll`（SHA-256 `d733489e…`，204,168,240 字节）的完整自动分析。
> 提取会话产物：`<本地临时目录>\wx-reverse\rea-session\`（fieldnum-* 共 45 个 JSON，text\ 下有提取后的伪代码）。
> 证据分级：**[硬]** = 反汇编直接读出；**[推]** = 结构+3.x 对照推断，需灰度验证。
> 所有 VA 的文件偏移换算：`file_offset = VA - 0x180001a00`（PE 段表映射已验证）。

## 1. 端点与 CGI

**[硬] verifyuser CGI = 137（0x89）**

- 端点描述符构造函数 `FUN_1819c6c90`（简单版）/ `FUN_1819c6fa0`（wrapper 版）在 `[RCX+0x10]` 写入 dword 立即数 `0x89`
- 对照组 getcontact `FUN_181007380` 同偏移写入 `0xb6=182`，与 hub 已知编号吻合，模式成立
- 路径 `/cgi-bin/micromsg-bin/verifyuser`（VA `0x1893ecb08`，唯一一份，两个构造函数均引用）
- wrapper 版交给注册器 `0x180688c10` 的两个回调：
  - `0x1819c7790`：响应解析入口（分配 400 字节 holder → `FUN_1819c7b00` 构造 → `FUN_183b203f0` 解析进消息）
  - `0x1819c75c0`：响应→业务回调（CopyFrom 响应消息 → 取 `BaseResponse.ret`（msg+0x10 的 int）与 `errmsg`（msg+0x8 的 string）→ `FUN_1819c7820` 提交 0x50 字节任务）
  - ⚠️ 修正轮 2-3 的标注：这两个都是响应侧回调；请求打包在业务层（尚未定位，见 §6）

## 2. micromsg.VerifyUserRequest（vtable `0x189814448`，对象 0xa0 字节，hasbits u32 @+0x98，默认实例 DAT_18bba80c8）

全名函数 `0x183b20520` [硬]。虚函数槽：slot0 析构 `0x183b22650`、slot1 全名、slot2 New/构造 `0x183b1edf0`、slot3 Clear `0x183b1ee70`、slot4 IsInitialized `0x183b20420`、slot6 MergeFrom `0x183b203e0`(thunk)=`FUN_183b1e4c0`（verify_user.pb.cc:0x6ad）、slot7 解析 `0x183b1f010`、slot8 ByteSizeLong `0x183b1ff50`、slot9 序列化 `0x183b1fcd0`。

字段表（解析 `0x183b1f010` / 序列化 `0x183b1fcd0` / ByteSize `0x183b1ff50` 三方一致）[硬]：

| 字段号 | wire | 类型 | 偏移 | hasbit | 备注 |
|---|---|---|---|---|---|
| 1 | 2 | message BaseRequest | +0x08 | 0x1 | **required**；0x38 字节，ctor `0x1806903e0`、dtor `0x1806908e0`、parse `0x180690990`、size `0x180690e10` |
| 2 | 0 | int32/uint32 | +0x10 | 0x2 | **required** [推] = opcode（accept=3） |
| 3 | 0 | int32/uint32 | +0x14 | 0x4 | **required** [推] = scene 或子操作类型 |
| 4 | 2 | repeated micromsg.VerifyUser | +0x18 ptr / +0x20 count / +0x28 cap | — | 元素 IsInitialized 被 required 检查 |
| 5 | 2 | string | +0x30 | 0x10 | [推] 验证内容/antispamticket 候选 |
| 6 | 0 | int32 | +0x4c | 0x20 | |
| 7 | 2 packed（也接受 wire0 非打包） | repeated int32 | +0x38 ptr / +0x40 count / +0x48 packed 长度缓存 | — | 写路径 tag `0x3a`；`FUN_180d61f50` 处理非打包分支 |
| 8 | 0 | int32 | +0x50 | 0x80 | |
| 9 | 2 | repeated micromsg.VerifyUserInfo | +0x58 ptr / +0x60 count | — | [推] accept 载荷：encryptusername+ticket 对 |
| 10 | 2 | message（0x20 字节共享类型） | +0x70 | 0x200 | ctor `0x180685de0`、parse `0x1806878d0`、size `0x180687ab0` |
| 11 | 2 | message（同上 0x20 字节类型） | +0x78 | 0x400 | |
| 12 | 0 | int32 | +0x90 | 0x800 | |
| 13 | 2 | string | +0x80 | 0x1000 | |
| 14 | 2 | string | +0x88 | 0x2000 | |

序列化代码摘录（`FUN_183b1fcd0`）：

```c
if ((uVar1 & 1) != 0)  FUN_1815f4190(1,  msg@+0x8,            stream);  // field 1 message
if ((uVar1 & 2) != 0)  FUN_1815f3e70(2,  *(int*)(this+0x10),  stream);  // field 2 varint
if ((uVar1 & 4) != 0)  FUN_1815f3e70(3,  *(int*)(this+0x14),  stream);  // field 3 varint
for (i = 0; i < count@+0x20; i++)
                       FUN_1815f4190(4,  elem@+0x18[i],       stream);  // field 4 repeated msg
if ((uVar1 & 0x10)!=0) FUN_1815f3fd0(5,  string@+0x30,        stream);
if ((uVar1 & 0x20)!=0) FUN_1815f3e70(6,  *(int*)(this+0x4c),  stream);
if (count@+0x40 > 0) { FUN_1815f3630(stream,0x3a);                      // field 7 packed tag
                       FUN_1815f3630(stream, packedlen@+0x48);
                       for (...) FUN_1815f3630(stream, ints@+0x38[i]); }
if ((hb & 0x80)!=0)    FUN_1815f3e70(8,  *(int*)(this+0x50),  stream);
for (i = 0; i < count@+0x60; i++)
                       FUN_1815f4190(9,  elem@+0x58[i],       stream);  // field 9 repeated msg
if ((uVar1 & 0x200)!=0)  FUN_1815f4190(10, msg@+0x70, stream);
if ((uVar1 & 0x400)!=0)  FUN_1815f4190(11, msg@+0x78, stream);
if ((uVar1 & 0x800)!=0)  FUN_1815f3e70(12, *(int*)(this+0x90), stream);
if ((uVar1 & 0x1000)!=0) FUN_1815f3fd0(13, string@+0x80, stream);
if ((uVar1 & 0x2000)!=0) FUN_1815f3fd0(14, string@+0x88, stream);
```

IsInitialized（`0x183b20420`）：`(~hasbits & 7) == 0` 才继续 → **字段 1、2、3 是 required**；再递归检查字段 1 消息、字段 4 每个元素、以及字段 10/11 消息（若存在）。

## 3. micromsg.VerifyUser（vtable `PTR_FUN_189814348`，对象 0x88 字节，hasbits 字节 @+0x80/+0x81/+0x82）

全名函数 `0x183b1e0f0` 返回字面量 `"micromsg.VerifyUser"` [硬]：
`builtin_strncpy(pcVar1,"micromsg.VerifyUser",0x14)`。

解析器 `0x183b1ce70`、序列化 `0x183b1d930`、ByteSize `0x183b1dc30`。字段表 [硬]：

| 字段号 | wire | 类型 | 偏移 | hasbit |
|---|---|---|---|---|
| 1 | 2 | string | +0x08 | 0x80&1 |
| 2 | 2 | string | +0x10 | 0x80&2 |
| 3 | 2 | string | +0x18 | 0x80&4 |
| 4 | 0 | int32 | +0x30 | 0x80&8 |
| 5 | 2 | string | +0x20 | 0x80&0x10 |
| 6 | 2 | string | +0x28 | 0x80&0x20 |
| 7 | 2 | string | +0x38 | 0x80&0x40 |
| 8 | 0 | int32 | +0x34 | 0x80&0x80 |
| 9 | 2 | string | +0x40 | 0x81&1 |
| 10 | 0 | int32 | +0x50 | 0x81&2 |
| 11 | 2 | message（0x20 字节共享类型，同 Request.10） | +0x48 | 0x81&4 |
| 12 | 2 | string | +0x58 | 0x81&8 |
| 13 | 0 | int32 | +0x54 | 0x81&0x10 |
| 14 | 2 | message（同上） | +0x60 | 0x81&0x20 |
| 15 | 0 | int32 | +0x78 | 0x81&0x40 |
| 16 | 2 | string | +0x68 | 0x81&0x80 |
| 17 | 2 | string | +0x70 | 0x82&1 |

字段 16/17 的 tag 为双字节 varint `0x82 0x01`（field 16）与 `0x8a 0x01`（field 17），解析器以 `*pcVar7 == -0x7e && pcVar7[1] == 1`（即 0x82,0x01）匹配 [硬]。

## 4. micromsg.VerifyUserInfo（vtable `0x1898143c8`，对象 0x20 字节，hasbit 字节 @+0x1c）

全名函数 `0x183b1e370` [硬]。解析 `0x1807b4dc0`、序列化 `0x1807b4f40`、ByteSize `0x1807b4f90`（MSVC COMDAT 落位在 0x1807b4xxx 区）。

| 字段号 | wire | 类型 | 偏移 | hasbit |
|---|---|---|---|---|
| 1 | 2 | string | +0x08 | 0x1 |
| 2 | 2 | string | +0x10 | 0x2 |

解析器摘录（`FUN_1807b4dc0`）[硬]：tag `0x0a`（field1）→ string@+0x8；tag `0x12`（field2）→ string@+0x10；解析器对连续 `0x0a`→`0x12` 做了内联快路径。

**[推] 语义：field1 = encryptusername，field2 = ticket**（通过/拒绝好友申请所需的用户对；与 Linux ELF 字符串池 `encryptusername`、`opcode` 相邻的痕迹一致；3.x 同名消息也是该二元组形态）。需灰度验证。

## 5. micromsg.VerifyUserResponse（vtable `0x189814568`，hasbit 字节 @+0x44，默认实例 DAT_18bba80d8）

全名函数 `0x183b21a40` [硬]。解析 `0x183b210f0`、序列化 `0x183b216c0`、ByteSize `0x183b217e0`、MergeFrom `0x183b208a0`（verify_user.pb.cc:0x996 处 CHECK）、CopyFrom `0x183b21990`、body 构造 `0x183b1be70`（vtable ptr = `PTR_FUN_189814568`）。

⚠️ 修正轮 3 标注：`FUN_183b1e4c0`（verify_user.pb.cc:0x6ad）是 **VerifyUserRequest**::MergeFrom（thunk `0x183b203e0`），不是 Response 的；Response 的 MergeFrom 是 `FUN_183b208a0`。

字段表 [硬]：

| 字段号 | wire | 类型 | 偏移 | hasbit | 备注 |
|---|---|---|---|---|---|
| 1 | 2 | message BaseResponse | +0x08 | 0x1 | 0x20 字节；ctor `0x18068c850`、parse `0x18068cad0`、copy `0x18068c870`；ret=int@+0x10、errmsg=string@+0x8（由响应回调用法证实） |
| 2 | 2 | string | +0x10 | 0x2 | |
| 3 | 2 | string | +0x18 | 0x4 | |
| 4 | 2 | message micromsg.VerifyUserSpamInfo | +0x20 | 0x8 | 0x30 字节；parse `0x183310750`（字段号未提取） |
| 5 | 2 | string | +0x28 | 0x10 | |
| 6 | 2 | string | +0x30 | 0x20 | |
| 7 | 0 | int64/uint64 | +0x38 | 0x40 | 写入用 64 位 varint writer `FUN_1815f3e40` |

响应回调任务结构（0x50 字节，`FUN_1819c75c0` 栈上）：+0x00 u32（框架参数）、+0x04 int ret、+0x08 string errmsg、+0x20 VerifyUserResponse 消息指针（fresh copy）。

VerifyUserSpamInfo（0x30 字节，hasbit @+0x28，CopyFrom `0x183b20570`）：bit1→u32@+0x20、bit2→string@+0x8、bit4→string@+0x10、bit8→string@+0x18；字段号未提取（parse 在 `0x183310750`），对本任务非关键。

## 6. 通过好友申请的最小请求模板 [推，待灰度]

```protobuf
VerifyUserRequest {
  BaseRequest base = 1;        // hub 现有 BaseRequest 构造
  uint32 opcode  = 2;          // accept = 3（preflight 假设；候选 {2=申请,3=通过,4=拒绝}）
  uint32 scene   = 3;          // required，具体取值待验证（preflight：V3/V4 场景）
  repeated VerifyUserInfo verifyuserinfo = 9 {
    string encryptusername = 1;  // 来自待通过申请
    string ticket          = 2;  // 来自待通过申请
  }
}
```

- CGI=137，path `/cgi-bin/micromsg-bin/verifyuser`，经 `authenticated_rpc(state, 137, "/cgi-bin/micromsg-bin/verifyuser", req)` 走 MMTLS 短连接
- opcode 与 scene 的实际取值、以及是否需要额外字段（如 5=content、7=repeated int32）由测试账号灰度验证定；响应 BaseResponse.ret=0 视为成功
- 若 ret != 0，响应字段 2/3/5/6（string）与 4（SpamInfo）携带错误与风控信息

## 7. 遗留与后续（可选，不阻塞实装）

1. 请求构建侧业务函数未定位：xrefs → `FUN_183b1edf0`（Request New）或 `DAT_18bba80c8` 可找到官方填充代码，一次新 REA 会话（xrefs + 少量反编译 ≈ 2h）可直接读出 opcode/scene 常量取值
2. 0x20 字节共享消息类型（Request.10/11、VerifyUser.11/14）与 SpamInfo 字段号未提取，accept 主路径不依赖
3. Linux ELF（4.1.13）交叉验证：在 ELF 上按「全名字符串 → vtable 块 → slot7/9 反编译」同样模式确认字段号一致（交接文档提示词已有）

## 8. 与 3.x 假设的对照

交接文档第 4 条旧假设（opcode=1, encryptusername=2, scene=3, content=4, ticket=5，均为 VerifyUserRequest 直挂字段）**全部不成立**：4.x 中 opcode 是 Request.2，encryptusername/ticket 收进 Request.9 的嵌套 VerifyUserInfo{1,2}，scene 推断为 Request.3。

## 9. hub 实装状态（2026-11-16）

实装位置：fork 仓库 `MoyunRz/agent-wechat` 分支 `feat/verify-user-accept`（提交 ba9199c，基于公开 upstream `thisnick/agent-wechat` @ cdb6635；本地 checkout 在私有工作目录，origin= fork（HTTPS），upstream= 官方）。CGI 编号与字段布局属协议事实（与现有 newsync/oplog 端点同风格中性语言），随公开 fork 发布已获用户确认。

已实装（本机验证：`cargo check` + `clippy` 三 crate 通过；wechat-protocol 5 个单测通过；core/api 测试与 `pnpm interfaces` 门禁因 Windows 缺 Perl/Node 24.22+ 无法本机执行，需 Linux CI 复核）：

1. 协议层 `crates/wechat-protocol/src/verify_user.rs`：CGI 137 + path，`VerifyUserAcceptRequest{encrypt_username, ticket, scene}`，opcode=3 常量，响应解析（BaseResponse.ret/errmsg，ret 保留符号），`NativeClient::verify_user_accept_snapshot`（快照式，无续期/重试/重登），scoped operation `operation!(verify_user_accept)`
2. core 层 `crates/wechat-core/src/verify_user.rs`（挂 runtime 子模块）：`set_contact_request_gate`（per-account 门，默认关）、频控（≥10s 间隔 + UTC 日桶 ≤20）、按材料哈希幂等（重复提交返回已录结果）、审计事件（`contact.request_accepted` / `contact.request_accept_failed`，只落长度与哈希，绝不落盘 encryptusername/ticket 明文）、`Core::accept_contact_request`（start_operation，kind=`contact-request-accept`）
3. HTTP API `crates/wechat-api`：`POST /v1/accounts/{a}/contacts/verify-user/accept`（scope send，Idempotency-Key 必填，202 返回 operation）与 `POST /v1/accounts/{a}/contacts/verify-user/gate`（scope send，开关门）；contracts + ROUTES 表 + http_interface_tests payloads 注册
4. 清单：`interfaces/http/routes.txt`、`interfaces/http/openapi.json` 手工增量更新（生成器输出无法在 Windows 复跑，CI `pnpm interfaces` 会校验）；`packages/shared/src/native.generated.ts` 经 `cargo run --example generate_contracts` 重生成；SDK `native-client.ts` 加 `acceptContactRequest`（客户端校验 + operation 身份校验）与 `setContactRequestGate`
5. changeset：`.changeset/contact-request-accept.md`（shared minor）

灰度验证步骤（部署环境，材料来自 P0-a 的 `GET /v1/accounts/{a}/friend-requests`）：

1. 编译部署含本实装的 hub，`POST .../contacts/verify-user/gate {"enabled":true}` 开门
2. `POST .../contacts/verify-user/accept`，body 用 friend-requests 返回的 V3(encryptUsername)/V4(ticket)/scene，Idempotency-Key 任取
3. 轮询 operation → result.serviceCode；ret=0 且测试账号收到通过通知 → opcode=3/scene 猜测成立；否则读 ret/errmsg/SpamInfo 调整 opcode 候选 {2=申请,4=拒绝} 或补字段（Request.5/7）
4. 验证后关门 `{"enabled":false}`；频控与幂等已内置（重复提交不重发）

UI 通过按钮（P0-a 已有申请卡片与「新的朋友」区块）仍在部署环境私有仓库中挂接——本 checkout 不含 37 投影与 friend-requests 端点，无法在此挂 UI；按钮语义：调用 accept 前置二次确认（display gate：`enabled=false` 时不显示或提示联系管理员开门）。
