---
name: protocol-recon
description: Develop a new WeChat CGI feature (search contacts, verify/friend requests, remarks, privacy, oplog actions, media CGIs) by harvesting wire-level truth the way upstream does. Use when a protocol field is unknown, a request returns -2 or Invalid argument, a new CGI must be implemented, or the user asks to reverse-engineer, hook, disassemble or capture WeChat protocol traffic. Not for merging upstream commits (see sync-upstream) or routine feature work without protocol unknowns.
---

# agent-wechat 协议取证与新功能对齐流程

目标：把「猜协议」换成「抄真值」。上游产能高的根因是每个功能都从 wire 层真值出发并固化为
fixture；本 skill 定义四层取证优先级（L0→L3）与配套资产，任何新 CGI 功能都按此顺序执行，
禁止一上来就写探针矩阵。

## 0. 硬约束（来自仓库规则，先读再动手）

- 研究笔记与抓包原始 hex 只进本私有 fork 的 `protocol-mapping/`；公开上游与公共 PR 中不得出现
  研究材料、账号数据、真实 ticket、内网地址与凭据。
- `AGENTS.md` 的 Protobuf changes 规则：改 codec 前必须对照受支持平台/构建的证据核对字段号、
  wire type、嵌套边界；**synthetic fixture 不能自证协议**——复制我们自己的输出不构成验证，
  fixture 必须来自真实抓包（L1）或私有参考仓库。
- Rust 工具链按 `rust-toolchain.toml`（fmt/clippy/test 门禁见 AGENTS.md）。

## 1. L0 — 上游当规格书（第一优先）

上游 `thisnick/agent-wechat` 对同构 Linux 4.1.x 客户端维护着与我们对齐的 codec，大多数功能
在动反汇编之前就能拿到答案。

```bash
git remote add upstream https://github.com/thisnick/agent-wechat.git  # 已有则跳过
git fetch upstream main
git grep -l "<关键字>" upstream/main -- packages/native-client-rust/crates/wechat-protocol/src/
git show upstream/main:packages/native-client-rust/crates/wechat-protocol/src/<file>.rs
```

- 逐字段核对：cgi、path、field 编号、wire type（`p::bytes` = length-delimited，`p::uint` = varint，
  `p::bytes(7, &p::varint(x))` 这种「bytes 里套 varint」是常见陷阱——wire type 错一个，
  handler 直接 Invalid argument）。
- 查上游该功能的 release notes / changesets，确认其验证方式（是否只有 synthetic fixture）。
- 移植 ≠ 照抄：upstream 与 fork 无共同祖先，整提交走 `sync-upstream` skill 的 cherry-pick；
  单功能移植是复制 codec 函数到我们的模块，并按第 5 节补 fixture。
- 上游没有的功能（或上游实现可疑）→ 进入 L1。

## 2. L1 — wire-tap：进程内抓 wire 真值（核心资产）

### 2.1 三条边界 hook（一次建设，所有 CGI 复用）

hook 业务函数（fill/构造器）会随版本与功能漂移；hook **边界函数**永不失效：

1. **请求序列化输出**：`serialize(this, out)` 的 `out` 是 libc++ std::string——onEnter 记录
   size，onLeave 读 size 增量的 delta 字节（否则读到上一次的残留）。
2. **MMTLS 加密前明文**：所有 CGI 请求的总闸门，按路径/cgi 过滤。
3. **MMTLS 解密后明文**：所有响应的真值。

定位方法：从已知 CGI 的 glue（栈上 `mov qword [rsp+0x10], <cgi>` + path 字符串）向下追一层
提交链即到加密边界；或从字符串 `/cgi-bin/micromsg-bin/<path>` 的引用反查。

### 2.2 Frida 实施要点（全部踩过的坑，不要重学）

- **spawn 模式**：yama `ptrace_scope=1` 时 attach 非子进程会失败；用
  `device.spawn([WECHAT], env=桌面会话环境)` + `attach(pid)` + `resume(pid)`，微信自动恢复登录态。
- **QuickJS 无 `btoa`**：字节序列化用 JS 循环拼 hex。
- **`send()` 不携带 bytearray**：payload 里的 bytes 必须自行转 hex 字符串，否则落成空对象。
- **libc++ std::string**：`{flag@0, size@8, ptr@16}`，短串内联（flag&1==0 时 size=flag>>1，
  data 在 +1）；二进制内容用 hex 读，不要 `readUtf8String`。
- **对象解引用先验 vptr**：读偏移字段前先比对 vptr（vtable VA+0x10）确认类身份，防止偏移
  挪动后抓错结构。
- **运行时基址**：所有 VA 偏移要减 module base（`Process.findModuleByName('wechat').base`）。
- 每个 hook 的 onEnter 打包 `tag` + 结构化字段 + 原始 hex，on_message 落盘 NDJSON。

### 2.3 产物：协议指纹库

```
protocol-mapping/captures/<feature>/
  <cgi>.req.hex / <cgi>.res.hex     # 完整 wire bytes（含 ticket 时不得提交公开仓库）
  meta.json                         # 客户端版本、动作、scene、时间、触发方式
```

配套 Rust fixture 测试（codec 回归门禁）：

```rust
#[test]
fn accept_matches_captured_wire() {
    let bytes = encoded(&state, &input, 3)?;
    assert_eq!(hex(&bytes), include_str!("../fixtures/accept.hex"));
}
```

- fixture 的期望值来自 L1 抓包（不是我们自己的输出）；
- 微信版本升级后重抓一次，diff fixture 即得形状变化清单；
- 含私密材料的 fixture 放 `protocol-mapping/captures/`（私有 fork），公开测试用合成值并
  在 PR 里声明验证缺口（AGENTS.md 规则）。

## 3. L2 — 静态反汇编（补语义与字段号）

L1 给出「形状」，L2 补「语义」（字段含义、handler 校验条件）。

- 工具：`objdump -d --start-address/--stop-address`（按 VA 范围）+ python3 脚本解析 ELF。
- **PIE 二进制 vtable 全零是常态**：真实指针在 `.rela.dyn` 的 `R_X86_64_RELATIVE` addend，
  按 r_offset 二分/线性查表解 vtable 槽；Itanium ABI 槽位：[8]=parse、[9]=ByteSizeLong、
  [10]=serialize、[3]=New。
- xref 扫描模式（python 扫 .text）：`e8/e9` rel32 找 call/jmp，`48 8d/4c 8d + modrm(rip)` 找
  lea 数据引用；对函数指针表（协程/虚调用）追到间接层尽头就停——**协程链、vtable dispatch
  追不动是常态，撤回 L1 动态取值**。
- 日志字符串是语义路标：fill/发起函数常带 `__FILE__/__LINE__` 日志调用（mov rcx, <line> +
  两个 rip-relative 字符串），字符串内容（类名/文件名）能直接定性函数归属。
- 段映射先核对：`.text` VA=file+0x1000、`.rodata` VA=offset 恒等、`.data.rel.ro` VA=file+0x2000
  （以 readelf -S 实测为准）。

## 4. L3 — 探针矩阵（最后手段）

仅当 L0 无答案、L1 无法触发该链路时使用。

- **一次只动一个变量**：opcode / scene / 载体字段 / ticket 编码分开试；组合爆炸前先停。
- **先路由后语义**：先确认请求进了 handler（业务层应答）再调字段值。
- **应答分层判读**：信封层 -2（encryption=0、payload=0B）= 路由/parse 失败，且有**随机抖动**，
  单次信封拒不能定罪形状，必须复测；业务层 serviceCode = handler 已跑，参数值错。
- 探针实现：`WX_VERIFY_PROBE` 环境变量开关 + 命名模式（official*/baseline*），收敛后删探针
  分支留正式实现；每轮结果记入 `protocol-mapping/*-probes.md` 对应节。

## 5. 收尾门禁（每个功能闭环）

1. codec 写完 → fixture 测试（真实抓包 hex）+ `cargo fmt/clippy/test`；
2. 新增字段/命令按 AGENTS.md 跑 `pnpm generate-types`、`pnpm interfaces`、加 `.changeset/`；
3. 研究结论追加到 `protocol-mapping/` 对应 spec/probes 文档（注明取证层级与客户端版本）；
4. 与上游同构的 codec 保留上游命名与注释风格，降低未来 merge 冲突。

## 6. RE 实验机速查

局域网 Ubuntu 22.04 桌面机（地址与 SSH 账号见本地工作区记录，勿提交入库）：
微信客户端在 `~/reverse/wechat-root/opt/wechat/wechat`（与反汇编目标同一文件，VA 偏移直接复用）；
frida 用户级安装在 `~/.local`（frida-tools，spawn 模式驱动脚本
`~/reverse/frida-accept/{hook_verifyuser.js, drive_verifyuser.py}`，NDJSON 落盘
`hook_out.log`）。重启机器后桌面会话需重新登录；驱动启动命令与已踩坑清单见
`protocol-mapping/verifyuser-grey-probes.md` §9.2。

## 7. 已知教训（不要重犯）

- wire type 猜错两次（f14 应为 SKBuiltinBuffer_t{iLen,pBuffer}；f7 应为 bytes 包 varint）——
  若一开始按 L0 读上游即可避免；**优先级顺序就是成本顺序**。
- 业务层语义定性要靠日志字符串/调用栈交叉验证，单点反汇编易误判（如把主动申请 fill 误当 accept）。
- 信封层 -2 有随机抖动，探针矩阵判读必须复测；抓包环境的高频重启会触发服务器端会话失效
  （`needs_login: no_usable_saved_trust`），节奏放缓。
