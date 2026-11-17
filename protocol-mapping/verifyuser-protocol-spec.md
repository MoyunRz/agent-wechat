# verifyuser 协议规格（Windows 4.x Weixin.dll 静态分析结论）

> 依据：Ghidra 12.1.4 对 `Weixin.dll`（SHA-256 `d733489e…`，204,168,240 字节）的完整自动分析。
> 提取会话产物：`%TEMP%\wx-reverse\rea-session\`（fieldnum-* 共 45 个 JSON，text\ 下有提取后的伪代码）。
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

实装位置：fork 仓库 `MoyunRz/agent-wechat` 分支 `feat/verify-user-accept`（提交 ba9199c，基于公开 upstream `thisnick/agent-wechat` @ cdb6635；origin= fork（HTTPS），upstream= 官方）。CGI 编号与字段布局属协议事实（与现有 newsync/oplog 端点同风格中性语言），随公开 fork 发布已获用户确认。

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

## 10. Linux ELF 4.1.13 交叉验证 + 官方填充代码定位（2026-11-17，radare2 6.2.6 静态分析）

> 目标二进制 `/opt/wechat/wechat`（181,205,660 B，ELF x86_64）。段映射：`.rodata` VA=文件偏移恒等；`.text` VA=file+0x1000（0x44ee000 起，0xA673EAC 止）；`.data.rel.ro` VA=file+0x2000（0xa67c290 起）。符号已剥离（仅 2 个动态导出）；C++ 符号名被混淆（typeinfo name 为 hex 串）。本轮工具：radare2（按 VA 寻址）+ 自写 rip 相对引用/call xref/立即数扫描器（`find_ref.py` / `find_call.py` / `find_opcode.py` / `find_glue.py`，在工作区根目录）。

### 10.1 端点定位（与 Windows 不同形态）

- 路径字符串 `/cgi-bin/micromsg-bin/verifyuser` @ VA `0x10124f4`（唯一一份，嵌在 MMTLS uri-hash 配置 blob 内，**无代码引用**）。Linux 端点描述符不是 .rdata 注册表，而是**业务 glue 函数栈上构造**。
- **verifyuser 端点 glue `0x69280a0`** [硬]：栈上内联 `mov qword [rsp+0x10], 0x89`（**CGI=137**，与 Windows 一致）+ libc++ long string{cap=0x29(odd), size=0x20=32, ptr=heap} 装 32 字节 path（movups 从 `0x1012504`/`0x10124f4`），随后 0x170B 任务对象 ctor `0x6928300`：cgi→task+0xc、path string→task+0x18、标志→task+0x31/+0x33、**request@+0x88、response@+0x128**（ctor `0x7f26b30`）→ `GetRequest` 虚调用后 `CopyFrom(req, 调用者预填的 VerifyUserRequest)`（`0x7f26170`）。
- 提交链 [硬]：`0x76be360`（协程续体，reloc `0xa9663a8` 引用）→ 填充函数 `0x69200e0` → glue `0x69280a0` → `0x6927dc0` → 适配器 `0x6927d10`（经服务 vtable `0xa8e4e40+5*8` 槽函数指针调用，typeinfo 名混淆）。
- **newsync 对照 glue `0x61e52a0`** [硬]：同构栈描述符 {cgi=0x8a(138), path="/cgi-bin/micromsg-bin/newsync"(29B)}。→ **verifyuser 与 newsync 共用同一通用 CGI 任务提交机制（shortlink 任务形态），官方客户端对 verifyuser 无独立 transport 分支**；glue 描述符里没有 longlink command 字段（之前猜的 0x29 实为 libc++ string capacity）。

### 10.2 消息类 vtable 地图（.data.rel.ro，Itanium ABI：[0]=D1、[1]=D0、[2]=GetFullName、[3]=New、[4]=Clear、[5]=IsInitialized、[6]=共享、[7]=CopyFrom、[8]=parse、[9]=ByteSizeLong、[10]=serialize、[11]=共享、[12]=尾 thunk）

| 类 | vptr | GetFullName | New | parse | serialize | ByteSizeLong |
|---|---|---|---|---|---|---|
| micromsg.VerifyUser (0x88B) | `0xa9c5378` | `0x7f23f30` | `0x7f228e0` | `0x7f22bb0` | `0x7f235a0` | `0x7f238b0` |
| micromsg.VerifyUserInfo (0x20B) | `0xa9c53f0` | `0x7f244a0` | `0x7f24130` | `0x7f241f0` | `0x7f24360` | `0x7f243b0` |
| micromsg.VerifyUserRequest (0xa0B) | `0xa9c5468` | `0x7f26280` | `0x7f24cd0` | `0x7f24ec0` | `0x7f25a50` | `0x7f25cf0` |
| micromsg.VerifyUserResponse | `0xa9c5558` | `0x7f27970` | `0x7f26f30` | `0x7f27080` | `0x7f27540` | `0x7f27660` |
| 尾类（6 字段 int/string×3，ctor `0x7f279b0`，0x38B 级） | `0xa9c55d0` | — | — | — | — | — |

### 10.3 字段表三方验证（ELF 上复核 Windows §2/§4 全部成立）[硬]

- Request::IsInitialized `0x7f261a0`：`not eax; test al,7`（hasbits u32 @+0x98）→ **required 字段 1/2/3 与 Windows 一致**；随后按 +0x8（field1 BaseRequest）、+0x18/+0x20（field4 repeated）、0x200 bit→+0x70（field10）递归检查。
- Request::parse `0x7f24ec0`：tag `0x22`（field4）快路径 alloc **0x88** + ctor `0x7f220b0`（VerifyUser）→ 挂 +0x18/+0x20 数组；另一臂 alloc **0x20** + ctor `0x7f23f50`（VerifyUserInfo）→ 挂 **+0x58/+0x60**（field9）。→ **field4=repeated VerifyUser、field9=repeated VerifyUserInfo、字段偏移 +0x08/+0x10/+0x14/…/hasbit@+0x98 与 Windows §2 完全一致**。
- VerifyUserInfo ctor `0x7f23f50`：vptr `0xa9c53f0`、清 +0x18、strings@+0x8/+0x10 置共享空串（`0xad1e8b0`）→ 0x20 字节两 string 布局成立（Linux hasbit dword @+0x18，Windows @+0x1c，ABI 差异无碍）。

### 10.4 官方填充函数 `0x69200e0`（Windows 侧 run3 未定位的关键缺口，本轮补上）[硬]

```c
// 0x69200e0(ctx_out, items, username_string, params) —— 栈上构建 VerifyUserRequest(rsp+0x180)
req.field2_opcode = 1;                 // mov dword [rsp+0x190],1 ; hasbit|0x2 @0x692015b/0x6920163
req.field3_scene  = 1;                 // mov dword [rsp+0x194],1 ; hasbit|0x4 @0x692047f/0x6920487
req.field4 += VerifyUser{              // 循环逐个元素（0x69201c1: alloc 0x88 + ctor 0x7f220b0）
  field1_string = username_string,     // or [r15+0x80],1 + string assign（arg3）
  field14_msg   = { string = serialize(0x38B 六字段 biz 对象) }  // ctor 0x7ba6400；源对象 ctor 0x7f279b0(vptr 0xa9c55d0)，
                                       // 6 字段 {int,string,int,string,int,string} 来自 params(+0x0/+0x8/+0x28/+0x30/+0x50/+0x58)
};
req.field7 += <int>;                   // repeated int32，容量增长 ×2 min 5（0x6920492 起）
```

- **opcode 与 scene 的实际取值是 1/1**（全二进制唯一 set_opcode 立即数点：rsp-disp32 对与 SIB-disp8 对两种形态扫描均仅命中 `0x69200e0`）。§2 的「opcode accept=3 [推]」与 §6 的 opcode=3/scene=15 模板**被硬证据推翻**。
- 官方 accept 流程的载重字段是 **field4（VerifyUser 列表）而非 field9（VerifyUserInfo{encryptusername,ticket}）**；VerifyUserInfo 元素仅由 parse/New/合并辅助创建，业务代码零直接调用。
- params 结构（arg4，r14）：+0x0 int→biz.f1、+0x4 flag、+0x8 string→biz.f2、+0x20 flag、+0x28 int→biz.f3、+0x2c flag、+0x30 string→biz.f4、+0x50 int→biz.f5、+0x54 flag、+0x58 string→biz.f6、+0x70 flag。

### 10.5 对 -2 的重解读与下一步探针

- 之前把「-2 + 空 payload + encryption=0」解读为「网关层拒绝、发生在 body 解析前」**不再成立**：官方客户端对 verifyuser 与读类 CGI 共用同一 shortlink 任务机制（§10.1），transport 假设排除。-2 与 **handler 参数校验失败**（required 缺失/opcode/scene 取值非法/形状不符）完全兼容。
- 下一轮形状矩阵建议（按 §10.4 硬证据构造）：
  1. `baseline2`：base + **opcode=1** + **scene=1** + field4=[VerifyUser{field1=encryptusername}]（不加 field9）
  2. `baseline2+ticket`：VerifyUser 再挂 field2/field3（string）= ticket / 内容候选
  3. `baseline2+biz`：VerifyUser.field14 = {string=ticket}（若服务端要求）
  4. `baseline2+field7`：field7=[1] / [scene 相关 int]
  - 响应 ret=0 或出现**非 -2** 的业务错误码即证明形状假设收敛；再迭代字段。
