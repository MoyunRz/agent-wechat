# 交接提示词：逆向微信 Linux 4.x 客户端，确认 verifyuser 协议规格

> 把下面整段复制给 Linux 侧的 Trae。任务全部离线静态分析，不向微信服务器发送任何请求。

---

## 任务目标

微信 4.x（Linux 版）的第三方协议实现项目 **agent-wechat**（Rust hub，包名 `wx-native`，二进制 `wx.exe`）目前缺少「同意/拒绝好友申请」的协议实现。我已在 Windows 侧完成字符串层证据收集，现需要你在 Linux 环境里用 **REA + Ghidra** 对官方客户端主二进制做反汇编分析，产出可直接实装的协议规格：

1. **verifyuser 的 cgi 编号**（发给服务器包头里的 16 位整数，反汇编证据）
2. **VerifyUserRequest 的完整 protobuf 字段表**（字段号 / wire type / 名称 / 嵌套关系，来自 descriptor 或构造函数反汇编）
3. **VerifyUserInfo 的嵌套结构**（同上；重点确认 opcode、encryptusername、scene、ticket 的字段号）
4. **VerifyUserResponse 字段表**
5. 每个结论附**反编译代码摘录 + 地址**（VA 与文件偏移对照）

最终交付：一份 `verifyuser-protocol-spec.md`（含全部证据地址与代码摘录）。

## 背景：agent-wechat 是什么

- agent-wechat 是微信 Linux 4.x 的纯协议实现（不是包装官方客户端）：MMTLS、newsync、收发消息、群操作等都在 Rust 里实现
- 源码工作区在 `packages/native-client-rust/`（crates: wechat-protocol / wechat-core / wechat-api / wechat-profile / wx）
- 如果你能拿到源码副本，参考这些文件理解请求包结构与现有 CGI 集成模式（可选，规格自足时不需要）：
  - `crates/wechat-protocol/src/client.rs` —— `authenticated_rpc(state, cgi, path, request)`：cgi 编号进包头，path 走 MMTLS 短连接路由
  - `crates/wechat-protocol/src/business.rs` —— `AuthenticatedPacket::prepare`：包头字段顺序 `client_version, uin, cookie, cgi(u16), original_length, pre_encryption_length, key_version=0, cert_version=39, checksum, compression(1=deflate/2=raw), encryption(13=主会话 envelope / 5=CBC), notice_id, sequence`
- 已实现并实测的 cgi 编号（4.x 沿用 3.x 编号体系）：`138=newsync, 182=getcontact, 222=sendappmsg, 110=uploadmsgimg, 149=uploadvideo, 127=uploadvoice, 128=downloadvoice, 379=getcdndns, 681=oplog, 8674=contactsync`

## 环境准备

```bash
# 1. 基础工具
node -v   # 需要 22.x / 24.x；npm install --global rea-agents
rea --version

# 2. Ghidra 12.1.x + JDK 21（Ghidra 12.x 要求 JDK 21）
export GHIDRA_INSTALL_DIR=/path/to/ghidra_12.1.x_PUBLIC
export JAVA_HOME=/path/to/jdk-21
export REA_GHIDRA_STARTUP_TIMEOUT_MS=7200000   # 启动时限 2 小时（实测 1 小时不够）
export GHIDRA_HEADLESS_MAXMEM=8G               # Ghidra 默认 2G 堆对大二进制不够
export REA_GHIDRA_DISABLED_ANALYZERS="Decompiler Parameter ID,Decompiler Switch Analysis,Aggressive Instruction Finder"

# 3. 下载官方 Linux 包（版本 4.1.13；如果本地没有就从官方 CDN 下载）
# https://dldir1v6.qq.com/weixin/Universal/Linux/WeChatLinux_x86_64.deb
tar -xf WeChatLinux_x86_64.deb            # 解出 data.tar.xz
tar -xJf data.tar.xz                      # 解出 opt/wechat/wechat（约 181MB ELF x86_64）
```

注意：官方参考构建是 **Linux 4.1.13.26 AMD64**（agent-wechat 项目文档记录，SHA-256 `2749535f299ba67feb8ef80cab898bb0531fa8f376b16f8a72db706811c84132` 是对应某版本的参考值；如果你拿到的是 4.1.13 的其他小版本，先在二进制里确认版本字符串并记录）。**REA 的 Ghidra provider 在 Linux 上完整支持 ELF**，不需要任何转换。

## Windows PE 主线已踩过的坑（不要重蹈覆辙）

Windows 侧对 204MB `Weixin.dll` 已失败两次，原因对 Linux 同样适用，请一开始就规避：

1. **REA CLI 每次调用都是隔离会话**：每次 CLI 调用新建一个临时 Ghidra 项目，结束时删除项目和 runtime 产物。`search → xrefs → decompile` 这类多步 CLI 工作流会对大二进制反复自动分析；实测 204MB DLL 连一次分析都没能在 1 小时时限内完成。→ 只用下面的「单 MCP 会话」工作流，整个提取过程只分析一次。
2. **MCP 客户端必须显式传长超时**：实测 `open_binary` 5 秒就返回，但 Ghidra 导入 + 自动分析仍在后台进行；下一个 `trace_feature` 阻塞 14.5 分钟后撞上 MCP SDK 默认 15 分钟请求超时，脚本失败路径又调用了 `close_binary` → REA 删除 Ghidra 项目，无法续跑，分析进度全部丢失。→ 每次 `callTool` 都显式传 `timeout`（首个调用 ≥ 4 小时）；失败路径绝不调用 `close_binary`，只在全部结果落盘后正常收尾。
3. **堆与高耗时分析器**：Ghidra 默认堆 2G；`Decompiler Parameter ID`、`Decompiler Switch Analysis`、`Aggressive Instruction Finder` 在大二进制上极耗时。→ 按环境准备一节的三个环境变量设置。
4. 「ghidra_startup: Waiting for Ghidra startup (N s elapsed)」这类进度消息是正常心跳，不要误判为卡死而重启进程。

## 我已在 Windows 侧拿到的字符串层证据（帮你跳过重复劳动）

以下偏移均指 **Linux 主二进制 `opt/wechat/wechat`（181208032 字节）内的文件偏移**：

1. **CGI 路径存在**：`/cgi-bin/micromsg-bin/verifyuser` @ file offset 16852221
2. **MMTLS uri-hash 表形态**（verifyuser 条目，供对照）：
   - 条目结构是 `a1 <NN00 十进制文本> b1 <hex 文本> c1` 的键值序列，`NN` 是 hash 字节数
   - verifyuser 前后：`1700` → `D295EB8DE509E9E22F1524DBF16E43AB8794116B095CE5`（16 字节）… path … `1E00` → `D291EF9CF848E1AD35082F98B0791AAC819217663558AF28C02DCCA3A17D`（32 字节）
   - 这些 hash 不是 SHA256(path)（我验证过不匹配），官方用它们做 MMTLS 路由查找；hub 侧按 path 现场算 hash，无需复用这些常量，但表结构本身可以佐证 cgi 路由方式
3. **protobuf 消息族**（符号池，来自 `.pb.cc` 生成的 full_name 字符串）：
   - `micromsg.VerifyUserRequest` @ 15626530
   - `micromsg.VerifyUserInfo` @ 15777430
   - `micromsg.VerifyUserResponse` @ 16279618
   - `micromsg.VerifyUserSpamInfo` @ 16080676
   - `micromsg.VerifyUserValidTicket` @ 16679945
   - 源文件路径字符串：`gen/protobufs/micromsg/verify_user.pb.cc` @ 14920648（`/data/devops-xwechat/workspace/xwechat_linux_x86_64_rel/out/build/kernel/` 构建树）
4. **字段名痕迹**：`encryptusername` 与 `opcode` 两个字符串相邻 @ 14890037（rodata 字符串合并区）；`antispamticket` @ 15590216 附近混有其他消息的字段（注意甄别）
5. **二进制内共有 193 个 `/cgi-bin/micromsg-bin/<name>` 路径**，verifyuser 在其中

## REA 工作流（单一 MCP 会话完成全部提取；不要用多步 CLI）

整个提取在一个 MCP 会话里完成：`open_binary` 一次，连续 trace / 反编译 / 落盘，最后才 `close_binary`。Windows 侧已有一份可运行的编排脚本（`rea-verifyuser-session.mjs`，在临时工作区，需要的话可以同步给你），核心骨架如下，可直接改路径复用：

```js
// rea-session.mjs —— 用 node 运行；先做一次 --probe 干跑（连接 + listTools）验证连通性
import { pathToFileURL } from "node:url";
import path from "node:path";
const reaRoot = "<npm root -g 输出>/node_modules/rea-agents";
const clientDist = path.join(reaRoot, "node_modules", "@modelcontextprotocol", "client", "dist");
const { Client } = await import(pathToFileURL(path.join(clientDist, "index.mjs")).href);
const { StdioClientTransport } = await import(pathToFileURL(path.join(clientDist, "stdio.mjs")).href);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(reaRoot, "scripts", "rea.mjs"), "mcp"],
  env: { ...process.env },          // 把上面导出的环境变量原样传入
  maxBufferSize: 64 * 1024 * 1024,  // 反编译输出可能超过默认 10MB
});
const client = new Client({ name: "verifyuser-session", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);
const call = (name, args, timeoutMs) =>
  client.callTool({ name, arguments: args }, { timeout: timeoutMs });
```

执行顺序（每一步结果立即落盘，建议同时写 JSONL 进度日志）：

1. `open_binary` `{ path: <ELF 路径> }` —— 它会很快返回，但 Ghidra 导入 + 自动分析在后台继续；之后的第一个操作可能阻塞几十分钟，**调用超时设 ≥ 4 小时**
2. 逐个跑 `trace_feature`（`{ query, case_sensitive: true }`），每条保存原始 JSON：
   - `/cgi-bin/micromsg-bin/verifyuser`（主目标）
   - `/cgi-bin/micromsg-bin/getcontact`（已知 cgi=182 的对照组，用于校准立即数模式）
   - `micromsg.VerifyUserRequest`、`micromsg.VerifyUserInfo`、`micromsg.VerifyUserResponse`（descriptor / 构造函数路线线索）
3. 从 trace 结果收集 `references[].containing_procedure.procedure.address`（去重），逐个 `procedure_pseudo_code`；直接引用路径字符串的函数额外跑 `procedure_assembly`
4. **全部文件落盘之后才调用 `close_binary`**；中途失败保持会话与进程存活，绝不主动 close
5. 探测分析是否就绪可用 `binary_session` 状态工具试一下（若它同样等待分析就绪，就退回等长超时调用返回）

### Windows PE 主线已确认的结论（供你在 ELF 上交叉验证）

Windows `Weixin.dll`（4.x，SHA-256 `d733489e…`）经 Ghidra 完整分析后已确认：

1. **端点描述符构造函数模式**（这是定位 CGI 编号的正确模式，改掉"立即数在发送函数里"的旧假设）：
   - 每个 CGI 端点有两个构造函数：简单版把「路径字符串 + CGI 编号」写入描述符对象；wrapper 版额外把两个函数指针（请求打包 / 响应解析回调）交给注册器 `0x180688c10`
   - **CGI 编号是描述符对象偏移 0x10 处的 dword 立即数**
   - 实测对照：getcontact 构造函数 `FUN_181007380` 在 `[RCX+0x10]` 写入 **0xb6=182**（与已知编号吻合，模式成立）；verifyuser 构造函数 `FUN_1819c6c90` 在同一偏移写入 **0x89=137**
   - → **Windows 4.x verifyuser CGI = 137（不是 3.x 的 23）**。请在 ELF 上用同一模式确认 Linux 版编号
2. verifyuser 路径字符串只有一份（VA 0x1893ecb08），被两个构造函数引用；请求/响应回调为 `0x1819c75c0` / `0x1819c7790`
3. **protobuf descriptor 不是明文 serialized FileDescriptorProto**：两个二进制里都搜不到 `verify_user.proto` 明文。字段表要从生成代码函数（构造 / SerializeWithCachedSizes / TcParseTable）反汇编提取，或从端点的请求打包回调提取
4. 3.x 字段假设（opcode=1, encryptusername=2, scene=3, content=4, ticket=5）仍是待验证假设，**4.x 字段号必须以反汇编为准**

5. **消息类 vtable 地图（轮 4-5 离线扫描确认，全部来自 .rdata 静态数据）**：
   - verify_user.pb.cc 的类块按内存顺序排列在 VA `0x189814340`-`0x1898145f0`，每块 = `[-1]` 指针 + vtable；**slot[0]=析构、slot[1]=GetFullName 全名函数**（已用全名函数内容逐一锚定）：
     - block A：vtable `0x189814348`，全名函数 `0x183b1e0f0`（类名待第 5 轮确认，疑似 `micromsg.VerifyUser`；0x88 字节元素，被大消息 repeated 引用）
     - block B：vtable `0x1898143c8`，全名函数 `0x183b1e370` = **`micromsg.VerifyUserInfo`**；slot[3]/[7]/[8]/[9] = 共享表驱动函数 `0x1807b4d50/0x1807b4dc0/0x1807b4f90/0x1807b4f40`
     - block C：vtable `0x189814448`，全名函数 `0x183b20520` = **`micromsg.VerifyUserRequest`**；自有虚函数 `0x183b1edf0/0x183b1ee70/0x183b20420/0x183b203e0/0x183b1f010/0x183b1ff50/0x183b1fcd0`（字段号头号候选）
     - block D：vtable `0x1898144d0`，全名函数 `0x183b20850` = `micromsg.VerifyUserSpamInfo`
     - block E：vtable `0x189814568`，全名函数 `0x183b21a40` = **`micromsg.VerifyUserResponse`**；自有虚函数 `0x183b20ef0/0x183b20f40/0x183b219c0/0x183b21980/0x183b210f0/0x183b217e0/0x183b216c0`
     - block F：vtable `0x1898145f0`，后随名字串 `micromsg.BizReportInfo`
   - `PTR_FUN_1893ecbc8` 是引用计数 holder（0x58 字节：vtable+refcnt+weakcnt+消息体@0x10）的 4 槽共享 vtable（0x18000ac2x），不是消息类 vtable；消息体由 `FUN_183b1be70`（请求）/`FUN_183b1be00`（响应）构造
   - ~~VerifyUserResponse::MergeFrom = `FUN_183b1e4c0`~~ **轮 5 修正：`FUN_183b1e4c0`（verify_user.pb.cc:0x6ad）是 VerifyUserRequest::MergeFrom（thunk `0x183b203e0` = Request vtable slot6）**；Response::MergeFrom = `FUN_183b208a0`（0x996 处 CHECK），Response hasbits@+0x44，与 Request（hasbits@+0x98）布局完全不同
   - **默认实例指针变量（DAT_18bba80c8/d8 等）在 BSS，运行时初始化**，磁盘 LE64 扫描全部 0 命中——Linux ELF 侧同样不要指望从磁盘扫 ClassData
   - ~~请求构造链：适配器 `0x1819c75c0`…~~ **轮 5 修正：`0x1819c75c0` 是响应→业务回调**（vtable+0x20 取已解析的 VerifyUserResponse → `FUN_183b21990`=Response::CopyFrom 复制 → 从 BaseResponse@msg+0x8 读 ret=int@+0x10 与 errmsg=string@+0x8 → `FUN_1819c7820` 创建 0x50 字节 task 提交）；`0x1819c7790` 是响应解析入口（alloc 400 字节 holder → `FUN_1819c7b00` 构造 → `FUN_183b203f0` 解析）；**请求打包发生在业务层，尚未定位**
6. **轮 5：全部字段号已提取完成（解析/序列化/ByteSize 三方自洽），最终结论见 [verifyuser-protocol-spec.md](2026-11-16-verifyuser-protocol-spec.md)**。要点：VerifyUserRequest 14 个字段（1=BaseRequest required、2/3=int32 required、4=repeated VerifyUser、9=repeated VerifyUserInfo{string,string}…）；VerifyUserInfo 仅 2 个 string 字段（field 1/2，推定 encryptusername/ticket）；VerifyUser（0x88 字节）17 个字段；VerifyUserResponse 7 个字段（1=BaseResponse、4=SpamInfo、7=int64）。产物：`rea-session\fieldnum-*`（45 个 JSON）+ `rea-session\text\`（伪代码文本）


### 定位 cgi 编号的具体建议（按已验证模式执行）

- **CGI 编号在端点描述符构造函数里**：找路径字符串的 xrefs → containing procedure 是构造函数（100~300 字节，特征：xmm 拷贝路径字符串 + `MOV dword ptr [RCX+0x10], <cgi>`）→ 立即数即 CGI 编号
- 先用已知 CGI 建立对照（如 getcontact：`[RCX+0x10]` 处应为 182），确认偏移语义后再读 verifyuser 的立即数
- 同一路径通常有两个构造函数（简单版 + wrapper 版），CGI 编号相同；wrapper 版传入的两个函数指针是请求打包 / 响应解析回调——**字段表就从这两个回调的反编译里提取**（getcontact 回调做对照：hub 已知 getcontact 182 的线上格式）
- Linux ELF 上同一模式同样适用，编号可能因平台/版本而异，以 ELF 读到的立即数为准

### 提取 VerifyUserRequest 字段结构

两条路线，都做、互相印证：

1. **descriptor blob**（首选）：protobuf C++ 生成的 serialized `FileDescriptorProto` 在 .rodata 里，特征是以 `0x0A <len>` + proto 文件名（如 `verify_user.proto`）开头，message name `VerifyUserRequest` 以**内联字节**出现在 blob 中（不是符号池那份）。找到 blob 后：
   - 用 `protoc --decode_raw` 或手写解析器解开（字段 1=name, 2=package, 4=message_type: DescriptorProto{1=name, 2=field: FieldDescriptorProto{1=name,3=number,4=label,5=type,...}}）
   - 输出 VerifyUserRequest / VerifyUserInfo / VerifyUserResponse 的完整字段表
2. **构造函数反汇编**：找 `VerifyUserInfo::VerifyUserInfo` / `SetCachedSize` / `SerializeWithCachedSizes` 类函数（符号池里有完整名），字段写入序列（`WriteUInt32ToArray(1, opcode, ...)` 等）直接给出字段号与 wire type

### 3.x 参考结构（只是假设，必须用 4.x 反汇编确认或推翻）

3.x/Pad 协议公开资料中的参考形态（**不要直接采信**，4.x 字段号可能有变化）：

```proto
// 假设形态，待 4.x 验证
message VerifyUserInfo {
    optional uint32 opcode = 1;          // 3=同意 4=拒绝
    optional string encryptusername = 2;
    optional uint32 scene = 3;
    optional string content = 4;         // 附言
    optional string ticket = 5;
    optional uint32 friendsyncflag = 6;
    optional string parentusername = 7;
    optional string parentdisplayname = 8;
    optional uint32 sourceconfirmflag = 9;
    // antispamticket 等扩展字段号待确认
}
message VerifyUserRequest { /* 大概率是 base=1(BaseInfo) + info=2(VerifyUserInfo) 的包裹层 */ }
```

3.x 的 verifyuser cgi 编号是 23，4.x 沿用概率高（138/182/222 等都沿用），**但必须以你反汇编读到的立即数为准**。

## 证据纪律（硬要求）

- 每个结论必须附**反汇编/反编译证据 + 地址**；读不到的证据标注 unknown，不许用 3.x 资料填充
- cgi 编号必须来自指令立即数或常量表，不接受「大概率是」
- 如果 descriptor blob 被压缩/混淆拿不到完整字段表，以构造函数反汇编结果为准，并注明覆盖了哪些字段、哪些字段未见
- 全程离线静态分析：**不要对微信服务器发送任何请求**，不要用真实账号做任何验证

## 交付格式

`verifyuser-protocol-spec.md`，包含：

1. 结论摘要（cgi 编号 + 三个消息的字段表）
2. 每个结论的证据（反编译摘录 + VA/file offset）
3. 与 3.x 参考结构的差异清单
4. 实装提示：哪些字段是同意操作必需的（opcode/encryptusername/scene/ticket 是否齐全）、哪些可选
5. 分析环境记录（REA 版本、Ghidra 版本、二进制版本字符串与 SHA-256）

---

补充：如果 Linux 侧没有 agent-wechat 源码，只按本提示词产出规格即可；实装在 Windows 侧完成。如果需要我把源码与已解包的二进制同步给你（rsync/scp 或压缩包），告诉我即可。
