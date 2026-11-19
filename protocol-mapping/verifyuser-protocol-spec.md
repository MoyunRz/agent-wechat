# verifyuser 协议规格（正式结论汇总）

> 汇总日期 2026-11-17。本文是 verifyuser（同意好友申请）协议的**唯一正式结论源**。
> 过程记录（探针矩阵、失败归因、工具踩坑）见 [verifyuser-grey-probes.md](verifyuser-grey-probes.md)；
> Windows 阶段历史交付快照在 `../docs/research/`（已过时，勿引用）。
>
> 证据来源与工具链：
> 1. **Windows PE**：Ghidra 12.1.4 完整分析 `Weixin.dll`（4.x，SHA-256 `d733489e…`，204,168,240 B）。VA→文件偏移换算：`file_offset = VA - 0x180001a00`。
> 2. **Linux ELF**：radare2 6.2.6 / objdump 静态分析 `opt/wechat/wechat`（4.1.13，两份样本 181,205,660 B / 181,208,032 B）。段映射：`.rodata` VA=文件偏移恒等；`.text` VA=file+0x1000；`.data.rel.ro` VA=file+0x2000；PIE 全量 RELA（R_X86_64_RELATIVE addend，基址 0xc0d8）。
> 3. **动态取证**：Frida 17.26.4（spawn 模式）hook <lab-host>（Ubuntu 22.04）上运行的微信 Linux 4.1.x 客户端——与反汇编同一二进制，VA 直接可用。
>
> 证据分级：**[硬]** = 反汇编/动态 dump 直接读出；**[推]** = 结构对照推断（标注验证状态）。

## 1. 端点与传输 [硬]

| 项 | 结论 | 证据 |
|---|---|---|
| CGI 编号 | **137（0x89）** | Windows：端点描述符构造函数 `FUN_1819c6c90`（简单版）/ `FUN_1819c6fa0`（wrapper 版）在 `[RCX+0x10]` 写 dword `0x89`；对照组 getcontact `FUN_181007380` 同偏移写 `0xb6=182`。Linux：端点 glue `0x69280a0` 栈上 `mov qword [rsp+0x10], 0x89`；newsync 对照 glue `0x61e52a0` 同构写 `0x8a=138` |
| 路径 | `/cgi-bin/micromsg-bin/verifyuser` | Windows VA `0x1893ecb08`（唯一一份，两个构造函数均引用）；Linux 文件偏移 16852221 / VA `0x10124f4`（嵌于 MMTLS uri-hash 配置 blob，无直接代码引用；glue 经 `0x1012504`/`0x10124f4` 装载） |
| 传输 | 与 newsync 共用同一通用 CGI shortlink 任务提交机制；**无独立 longlink 分支** | Linux 提交链：协程续体 `0x76be360` → fill `0x69200e0` → glue `0x69280a0` → `0x6927dc0` → 适配器 `0x6927d10`（经服务 vtable `0xa8e4e40+5*8` 槽调用）；glue 任务对象 {cgi@+0xc, path@+0x18, request@+0x88, response@+0x128}，无 longlink command 字段 |
| 服务器路由 | **按 URL path 路由**，pack 头 cgi 号被忽略 | 灰度探针（cgi/path 交叉）：pack 头 182 + path=/verifyuser → 响应回显 137；pack 头 137 + path=/getcontact → 响应回显 182 |

hub 集成模式：`authenticated_rpc(state, 137, "/cgi-bin/micromsg-bin/verifyuser", req)`，MMTLS 短连接。

## 2. 消息字段表（Windows / Linux 双平台交叉验证，字段号全部 [硬]）

### 2.1 vtable / 关键函数对照

| 类 | Win vtable | Linux vptr | 关键函数（Win / Linux） |
|---|---|---|---|
| VerifyUser（0x88B） | 0x189814348 | 0xa9c5378 | Win：全名 0x183b1e0f0、parse 0x183b1ce70、serialize 0x183b1d930、ByteSize 0x183b1dc30；Linux：New 0x7f228e0、parse 0x7f22bb0、serialize 0x7f235a0、ByteSizeLong 0x7f238b0、元素 ctor 0x7f220b0 |
| VerifyUserInfo（0x20B） | 0x1898143c8 | 0xa9c53f0 | Win：全名 0x183b1e370、parse 0x1807b4dc0、serialize 0x1807b4f40、ByteSize 0x1807b4f90；Linux：New 0x7f24130、parse 0x7f241f0、serialize 0x7f24360、ctor 0x7f23f50 |
| VerifyUserRequest（0xA0B） | 0x189814448 | 0xa9c5468 | Win：全名 0x183b20520、New 0x183b1edf0、Clear 0x183b1ee70、IsInitialized 0x183b20420、MergeFrom 0x183b1e4c0（thunk 0x183b203e0）、parse 0x183b1f010、ByteSizeLong 0x183b1ff50、serialize 0x183b1fcd0；Linux：New 0x7f24cd0、parse 0x7f24ec0、serialize 0x7f25a50、ByteSizeLong 0x7f25cf0、IsInitialized 0x7f261a0、CopyFrom 0x7f26170 |
| VerifyUserResponse | 0x189814568 | 0xa9c5558 | Win：全名 0x183b21a40、parse 0x183b210f0、serialize 0x183b216c0、ByteSizeLong 0x183b217e0、MergeFrom 0x183b208a0、CopyFrom 0x183b21990、body ctor 0x183b1be70；Linux：New 0x7f26f30、parse 0x7f27080、serialize 0x7f27540 |
| 0x38B 尾类 | — | 0xa9c55d0 | Linux：ctor 0x7f279b0、serialize 0x7f280f0 |
| SKBuiltinBuffer_t | — | 0xa9987f8+0x10 | Linux：ctor 0x7ba6400、parse 0x7ba6680、serialize 0x7ba67f0；全名 `micromsg.SKBuiltinBuffer_t`（26B @0xda5b76） |

Itanium ABI（Linux）槽位：[0]=D1、[1]=D0、[2]=GetFullName、[3]=New、[4]=Clear、[5]=IsInitialized、[7]=CopyFrom、[8]=parse、[9]=ByteSizeLong、[10]=serialize。MSVC（Windows）slot0=析构、slot1=全名、slot7=解析、slot8=ByteSizeLong、slot9=序列化。

### 2.2 micromsg.VerifyUserRequest（0xA0 字节，hasbits u32 @+0x98，Win 默认实例 DAT_18bba80c8）

解析 / 序列化 / ByteSize 三方自洽 [硬]：

| 字段号 | wire | 类型 | Win 偏移 | hasbit | 备注 |
|---|---|---|---|---|---|
| 1 | 2 | message BaseRequest | +0x08 | 0x1 | **required**；0x38B；Win ctor 0x1806903e0 / dtor 0x1806908e0 / parse 0x180690990 / size 0x180690e10 |
| 2 | 0 | int32/uint32 | +0x10 | 0x2 | **required** = opcode；1=主动申请（fill 立即数）、3=accept（Frida dump） |
| 3 | 0 | int32/uint32 | +0x14 | 0x4 | **required** = scene；accept 观测值 1（单样本，见 §3） |
| 4 | 2 | repeated VerifyUser | +0x18 ptr / +0x20 count / +0x28 cap | —（count 判存） | **accept 载重载体**（官方 accept 用 field4，元素见 §3/§6） |
| 5 | 2 | string | +0x30 | 0x10 | accept 置位但为**空串**（cap=15 空 SSO）[硬] |
| 6 | 0 | int32 | +0x4c | 0x20 | accept = **1** [硬] |
| 7 | 2 packed（也接受 wire0 非打包） | repeated int32 | +0x38 ptr / +0x40 count / +0x48 packed 长度缓存 | —（count） | Win 写路径 tag `0x3a`；accept = **[申请来源 scene]**（样本 [15]）[硬]；申请 fill 有追加 |
| 8 | 0 | int32 | +0x50 | 0x80 | |
| 9 | 2 | repeated VerifyUserInfo | +0x58 ptr / +0x60 count | —（count） | **官方 accept 弃用（field9 空）**；灰度探针中 field9 形状可进 handler 但返回 Invalid argument |
| 10 | 2 | message（0x20B 共享类型） | +0x70 | 0x200 | Win ctor 0x180685de0 / parse 0x1806878d0 / size 0x180687ab0 |
| 11 | 2 | message（同上 0x20B 共享类型 = SKBuiltinBuffer_t 同款） | +0x78 | 0x400 | accept 携带动态 blob；**wire = {1:len, 2:blob}**（serialize 0x6a55f0 实锤，见 §3） |
| 12 | 0 | int32 | +0x90 | 0x800 | |
| 13 | 2 | string | +0x80 | 0x1000 | |
| 14 | 2 | string | +0x88 | 0x2000 | |

IsInitialized（Win 0x183b20420 / Linux 0x7f261a0）：`(~hasbits & 7) == 0` 才继续 → **字段 1、2、3 required**；递归检查字段 1 消息、字段 4 各元素、字段 10/11 消息（若存在）。

Linux parse `0x7f24ec0` 佐证：tag `0x22`（field4）快路径 alloc 0x88 + ctor 0x7f220b0（VerifyUser）挂 +0x18/+0x20；另一臂 alloc 0x20 + ctor 0x7f23f50（VerifyUserInfo）挂 +0x58/+0x60 —— 与上表完全一致。

### 2.3 micromsg.VerifyUser（0x88 字节，hasbits 字节 @+0x80/+0x81/+0x82）

17 个字段 [硬]；f16/f17 tag 为双字节 varint `0x82 0x01` / `0x8a 0x01`，Win 解析器以 `0x82,0x01` 匹配：

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
| 11 | 2 | message（0x20B 共享类型） | +0x48 | 0x81&4 |
| 12 | 2 | string | +0x58 | 0x81&8 |
| 13 | 0 | int32 | +0x54 | 0x81&0x10 |
| 14 | 2 | message **SKBuiltinBuffer_t** | +0x60 | 0x81&0x20 |
| 15 | 0 | int32 | +0x78 | 0x81&0x40 |
| 16 | 2 | string | +0x68 | 0x81&0x80 |
| 17 | 2 | string | +0x70 | 0x82&1 |

已知语义 [硬，动态取证]：**accept 元素仅填 f1/f2**（元素 hasbits=0x03）——f1 = **申请人 wxid 明文**（申请 fill 同样将"对方" username 写入 f1），f2 = **申请卡片 v4 ticket 整串原样**（含 `@stranger` 后缀，不剥前缀）；f14 = SKBuiltinBuffer_t 载体（仅申请路径 fill 使用，accept 不用）；其余字段在 accept 中缺席。

### 2.4 micromsg.VerifyUserInfo（0x20 字节，两 string）

| 字段号 | wire | 类型 | Win 偏移 | hasbit |
|---|---|---|---|---|
| 1 | 2 | string | +0x08 | 0x1 |
| 2 | 2 | string | +0x10 | 0x2 |

[推] 语义 field1=encryptusername、field2=ticket（Linux 字符串池 `encryptusername`/`opcode` 相邻痕迹 + 3.x 同名消息二元组形态，未线上验证）。**注意：官方 accept 不使用 field9**，本消息在 accept 主路径中无角色；业务代码中仅由 parse/New/合并辅助创建，零直接调用。

### 2.5 micromsg.VerifyUserResponse（hasbits @+0x44，Win 默认实例 DAT_18bba80d8）

| 字段号 | wire | 类型 | Win 偏移 | hasbit | 备注 |
|---|---|---|---|---|---|
| 1 | 2 | message BaseResponse | +0x08 | 0x1 | 0x20B；ctor 0x18068c850 / parse 0x18068cad0 / copy 0x18068c870；ret=int@+0x10、errmsg=string@+0x8（响应回调用法证实） |
| 2 | 2 | string | +0x10 | 0x2 | |
| 3 | 2 | string | +0x18 | 0x4 | |
| 4 | 2 | message VerifyUserSpamInfo | +0x20 | 0x8 | 0x30B；Win parse 0x183310750，**字段号未提取**；对象内 bit1→u32@+0x20、bit2→string@+0x8、bit4→string@+0x10、bit8→string@+0x18 |
| 5 | 2 | string | +0x28 | 0x10 | |
| 6 | 2 | string | +0x30 | 0x20 | |
| 7 | 0 | int64/uint64 | +0x38 | 0x40 | 64 位 varint writer（Win FUN_1815f3e40） |

响应侧回调（Windows，wrapper 构造函数交给注册器 `0x180688c10`）：
- `0x1819c7790` 响应解析入口：alloc 400B holder → `FUN_1819c7b00` 构造 → `FUN_183b203f0` 解析。
- `0x1819c75c0` 响应→业务回调：CopyFrom（0x183b21990）复制响应 → 读 BaseResponse ret/errmsg → `FUN_1819c7820` 提交 0x50B task（+0x00 u32 框架参数、+0x04 ret、+0x08 errmsg、+0x20 响应消息 fresh copy 指针）。

ret=0 视为成功；ret≠0 时字段 2/3/5/6（string）与 4（SpamInfo）携带错误与风控信息。**accept 成功样本（ret=0）中 f2 = 申请人 wxid 回显**（与请求元素 f1 同值），f3/f5/f6 空串、f7=0、SpamInfo 空。

### 2.6 SKBuiltinBuffer_t 与 0x38B 尾类 [硬，Linux]

**SKBuiltinBuffer_t**（0x20B 级，hasbit dword @+0x18）：`{1: uint32 iLen @+0x10（varint）, 2: bytes pBuffer @+0x8（len-delim）}`——长度前缀惯用法 `{1: <pBuffer 字节长度>, 2: <序列化字节>}`。VerifyUserRequest.fill 序列：`hasbit|=2 → pBuffer ← serialize(biz)`，随后 `hasbit|=1 → iLen ← pBuffer 长度`。

**0x38B 尾类**（serialize 0x7f280f0，六字段 {int,string,int,string,int,string}；字段号假设 1..=6 由 Write helper tag 反推实锤）：

| hasbit | 字段号 | wire | 对象偏移 |
|---|---|---|---|
| bit0 @0x30 | 1 | varint int32 | +0x10 |
| bit1 | 2 | len-delim string | +0x08 |
| bit2 | 3 | varint int32 | +0x14 |
| bit3 | 4 | len-delim string | +0x18 |
| bit4 | 5 | varint int32 | +0x28 |
| bit5 | 6 | len-delim string | +0x20 |

申请 fill（`0x69200e0` arg4 params，r14）映射：+0x0 int→biz.f1、+0x8 string→biz.f2、+0x28 int→biz.f3、+0x30 string→biz.f4、+0x50 int→biz.f5、+0x58 string→biz.f6（每个字段带独立 presence flag：+0x4/+0x20/+0x2c/+0x54/+0x70）。

## 3. 官方 accept 请求形状 [硬，动态取证：Linux Frida + Windows Frida 双平台]

> 证据一（Linux）：<lab-host> 微信 Linux 4.1.x 客户端，Frida 17.26.4 spawn 模式 hook fill/CopyFrom/serialize/glue，
> dump 对象 +0x10 opcode=3、+0x14 scene=1、+0x20 f4 size=1、+0x58 field9 空、+0x98 hasbits=0x437。
> 证据二（Windows）：4.2.0.13 客户端（`Weixin.dll` SHA-256 `afe3d02c…`）serialize 入口完整对象 dump，
> ret=0 成功样本，账号角色已确认（同意方=昵称C，申请人=昵称A `wxid-self-a`）。见 §9。

**两平台 dump 完全一致**（hasbits 0x437、opcode=3、scene=1、field4 载重、field9 空）。
hasbits 0x437 解码（位表为硬证据）→ 置位字段 = {1 BaseRequest, 2 opcode, 3 scene, 5 string, 6 int32, 11 message 0x20B}。

**确立的 accept 形状（完整，Windows ret=0 样本）**：

```protobuf
VerifyUserRequest {
  BaseRequest base = 1;
  uint32 opcode = 2;        // 3 = accept [硬]
  uint32 scene = 3;         // 1 [硬]（两平台、多样本一致；与申请来源 15 无关）
  repeated VerifyUser vus = 4;   // ×1；Windows 布局为元素指针数组（元素各自堆分配），Linux 侧需解引用
  string f5 = 5;            // hasbit 置位但为空串（cap=15 空 SSO）
  int32  f6 = 6;            // 1 [硬]
  repeated int32 f7 = 7;    // [15] = 申请来源 scene [硬]
  F11Msg f11 = 11;          // 动态加密载荷，见下
  // f8/f9/f10/f12/f13/f14 全部缺席；field9（VerifyUserInfo）被官方 accept 完全弃用
}
// VerifyUser 元素（元素 hasbits = 0x03，仅两个字段）：
//   f1 string = 申请人 wxid 明文（'wxid-self-a' = 昵称A = 申请人；同意方是 昵称C）
//   f2 string = 申请卡片携带的 v4 ticket 整串原样（'v4_000b708f…@stranger'，350B，不剥前缀不解码）
//   f14 SKBuiltinBuffer_t 在 accept 中不使用（仅申请路径 fill 使用）
```

**f11 子消息（0x20B 共享类 = SKBuiltinBuffer_t 同款布局，对象 {string ptr@+0x8, int len@+0x10, cachedSize@+0x14, hasbits@+0x18}）**：

```
f11 wire = { 1: uint32 blob长度, 2: bytes blob }        // serialize 0x6a55f0 反汇编实锤（field1=WriteInt32(len)、field2=WriteString(blob)）
                                                        // cachedSize(+0x14)与hasbits(+0x18)不序列化
blob (7859B 样本) = { 3: { 1: 7850,                       // 内层长度
                           2: { 1: "00000001\0" (9B),     // 固定 ID（疑似 snprintf "%08d" 生成）
                                2: 15,                    // 申请来源 scene
                                3: <加密载荷 7840B> } } }  // 客户端生成的反垃圾/验证材料，两轮大小不同（7840/7872），随请求动态变化
```

**VerifyUserResponse（ret=0 成功样本）**：BaseResponse.ret=0、errmsg 空；f2 = 申请人 wxid（回显，与元素 f1 同值）；f3/f5/f6 空；f7=0；SpamInfo 空。

**灰度矩阵失败归因闭合**（探针细节见 grey-probes §9/§9.1）：

| 请求形状 | 观测结果 |
|---|---|
| opcode=1 / scene=1（含 field4/f14 biz 形状，official1-18） | handler 层 Invalid argument（opcode=1 是申请语义，按申请校验 accept 材料） |
| opcode=1 + scene=15（official16） | 信封层拒 |
| opcode=3 + scene=15 + field4（official14/19） | 信封层拒（稳定复现）——accept 的 opcode=3 要求 scene=1 |
| opcode=3 + scene=15 + field9（grey 旧模板 + official20-23） | handler 层 IA / 信封拒混合（scene 与载体双错） |
| **opcode=3 + scene=1 + field4[{f1:申请人wxid, f2:v4 ticket}]（官方形状）** | **Windows 动态样本 ret=0 成功** |

另：信封层 -2 有随机抖动（official17 同形状两次落在不同层），单次信封拒不能定罪形状；「信封 -2 = 网关层拒绝」解读已撤销（见 §5）。
旧灰度全部失败的第二根因：**官方 accept 携带 f5/f6/f7/f11，探针从未发送过 f11 blob**（是否必需待 hub 探针验证）。

## 4. 主动申请路径（opcode=1）[硬]

fill `0x69200e0(ctx_out, items, username_string, params)`：栈上构建 VerifyUserRequest，`opcode=1`、`scene=1`（立即数写点；全二进制唯一 set_opcode 点，rsp-disp32 与 SIB-disp8 两种形态扫描均仅命中此处）；field4 追加 `VerifyUser{f1=username(arg3), f14=SKBuiltinBuffer_t{1:len, 2:serialize(0x38B biz)}}`；field7 追加 int（容量增长 ×2 min 5）。

协程链：协程 A `0x76bde20`（日志上下文 `mmui::ContactHeadView` 联系人资料页，`__LINE__=0x7b5`）分配 0x160 frame（vtable 0xa966378；frame+0x10 ← username 拷贝、frame+0x28 ← params 布局拷贝）→ resume `0x76be360` → fill → 无 opcode/scene 覆盖 → 组装回调对象提交。

→ **opcode=1 = 主动发起好友申请语义**。全二进制无 opcode=3 立即数写点 → accept 的 opcode 是运行时变量，官方 accept 构造点（业务层）尚未定位（候选：oplog 路线 / 服务器端独立 handler / 客户端与服务器 proto 分歧）。

## 5. 已推翻假设归档

| 假设 | 状态 | 推翻/修正证据 |
|---|---|---|
| 3.x 模板（opcode=1、encryptusername=2、scene=3、content=4、ticket=5 直挂 Request） | 全部不成立 | 4.x 双平台字段表（§2.2） |
| 旧实装模板 accept = opcode=3 + scene=15 + field9 VerifyUserInfo{encryptusername, ticket} | 不成立 | Frida dump：scene=1、field9 空、field4 载重；灰度探针 IA |
| opcode=1 = accept | 不成立 | fill `0x69200e0` 语义为 ContactHeadView 主动申请；accept 材料按申请校验返回 IA |
| 信封 -2 空 payload = 网关层拒绝（body 解析前） | 撤回 | 官方 verifyuser 与读类 CGI 共用同一 shortlink 提交机制；cgi/path 交叉探针拿到业务层应答（serviceCode=-2 "Invalid argument"）；-2 与 handler 参数校验失败兼容 |
| VerifyUser.f14 = string{serialize(biz)} | 修正 | serialize 0x7f280f0 / 0x7ba67f0：f14 = SKBuiltinBuffer_t{1:len, 2:bytes} |
| longlink command 通道候选遍历（91/121/137/257） | 不必要 | §1 传输结论：glue 同构 newsync，无 longlink 字段，短连接即官方通道 |
| Linux 端点描述符为 .rdata 注册表（Windows 形态） | 不成立 | Linux 为业务 glue 栈上构造描述符（`mov qword [rsp+0x10], 0x89`） |
| 服务器按 pack 头 cgi 路由 | 不成立 | cgi/path 交叉探针：按 URL path 路由 |
| VerifyUserResponse::MergeFrom = `FUN_183b1e4c0`（Win 轮 3 标注） | 修正 | `FUN_183b1e4c0` 是 Request::MergeFrom；Response::MergeFrom = `FUN_183b208a0` |
| accept 元素需要 f14/biz 结构 | 不成立 | 动态 dump：accept 元素 hasbits=0x03 仅 f1/f2；f14 SKB 仅申请路径使用 |
| accept 元素 f1 = encryptusername / 加密名 | 不成立 | f1 = 申请人 wxid 明文（角色确认：同意方 昵称C、申请人 昵称A） |
| ticket 需剥 `v2_ticket@str=` / 解码 | 不适用 | accept f2 = v4 ticket 整串原样（含 `@stranger` 后缀） |
| f11 可省略 | **未证（最大实现风险）** | 官方 accept 携带 ~7.9KB 动态加密 blob；hub 探针需验证缺省时服务器是否接受 |

## 6. 未决问题（按阻塞程度排序）

1. **f11 blob 的必要性与生成算法（最大实现风险）**：官方 accept 携带 ~7.9KB 动态加密载荷（结构见 §3），客户端生成、两轮大小不同（7840/7872）。hub 无法直接复刻该加密——需灰度探针验证：**缺省 f11（以及 f5/f6/f7）时服务器是否仍接受**。若必需，需进一步定位客户端 blob 生成函数（Windows `biz.big 0x1a661e0` 上游链：`0x1a6888d ← 0x1a75a3a ← 0x17ccf41 ← 0xdd358a ← 0x4ab74a ← 0x4aa70f ← 0x76b5b60 ← 0x687f040`）。
2. **scene=1 的取值规律**：两平台多轮样本均为 1（申请来源=手机号搜索/15）；是否 accept 固定 1 还是随来源变化待多样本。
3. **f5（空串置位）/f6=1/f7=[scene] 是否服务端必需**：与 f11 一起在探针矩阵中逐项增删验证。
4. ~~0x20B 共享类字段号~~ **已闭合**：f11 包装类 wire = `{1: uint32 len, 2: bytes blob}`（SKBuiltinBuffer_t 同款，Win serialize 0x6a55f0 反汇编实锤）；blob 内层结构亦已从内容解码（{3:{1:len, 2:{1:"00000001\0", 2:scene, 3:encrypted}}}）——hub 构造/解析 f11 的线格式无障碍，剩余风险仅在加密载荷本身。
5. VerifyUserSpamInfo 字段号（Win parse `0x183310750`）——accept 主路径不依赖。

已闭合（原待办 → 结论）：元素内部 → §2.3/§3；Request 级 f5/f6/f11 内容 → §3；accept 构造点 → §6 第 1 条调用链 + Windows glue `0x1a7a550`；ticket 编码 → f2 原样。

## 7. hub 实装状态（2026-11-17）

实装位置：fork `MoyunRz/agent-wechat` 分支 `feat/verify-user-accept`（提交 ba9199c，基于公开 upstream `thisnick/agent-wechat` @ cdb6635；本地 checkout 位于私有工作目录）。CGI 编号与字段布局属协议事实，随公开 fork 发布已获用户确认。

已实装（本机验证：`cargo check` + clippy 三 crate 通过；wechat-protocol 5 个单测通过；core/api 测试与 `pnpm interfaces` 因 Windows 缺 Perl/Node 24.22+ 需 Linux CI 复核）：

1. 协议层 `crates/wechat-protocol/src/verify_user.rs`：CGI 137 + path、`VerifyUserAcceptRequest{encrypt_username, ticket, scene, username}`、opcode=3 常量、响应解析（BaseResponse.ret/errmsg，ret 保留符号）、`verify_user_accept_snapshot`（快照式，无续期/重试/重登）、scoped operation `operation!(verify_user_accept)`。
2. core 层 `crates/wechat-core/src/verify_user.rs`：per-account gate（默认关）、频控（≥10s 间隔 + UTC 日桶 ≤20）、按材料哈希幂等（重复提交返回已录结果）、审计事件（`contact.request_accepted` / `contact.request_accept_failed`，只落长度与哈希，绝不落盘 encryptusername/ticket 明文）、`Core::accept_contact_request`。
3. HTTP API：`POST /v1/accounts/{a}/contacts/verify-user/accept`（scope send，Idempotency-Key 必填，202 返回 operation）与 `POST /v1/accounts/{a}/contacts/verify-user/gate`（scope send，开关门）；contracts + ROUTES 表 + http_interface_tests payloads 注册；SDK `acceptContactRequest` / `setContactRequestGate`；changeset `.changeset/contact-request-accept.md`。
4. 诊断设施：operation 失败携带根因文本（≤500B）；信封拒绝时尽力解密提取业务 errmsg，附 `reply-cgi/encryption/compression/payload len/head hex` 元数据；`WX_VERIFY_PROBE`（请求形状）/ `WX_VERIFY_CROSS`（cgi/path/通道）/ `WX_PROTOCOL_TRACE=1`（逐阶段 stderr trace：encode → pack → mmtls → envelope → handler，只打长度与密文 hex 头，不含敏感明文）。

**已知差距（2026-11-17 更新）**：encode 已按 §3 官方形状**重写完成**（本机 cargo fmt/clippy(lib,bins)/协议层 257 测试通过；core/api 全量测试因 Windows 缺失 Unix-only 测试代码编译仍需 Linux CI 复核）——`opcode=3 + scene=1 + field4=[VerifyUser{f1:申请人wxid明文, f2:v4 ticket原样}] + f5:"" + f6:1 + f7:[申请scene]`（packed varint），默认不带 f11（无法复刻加密载荷）。`WX_VERIFY_PROBE` 变体开关：`minimal`（仅 f4）/`nof7`/`nof6`/`nof5`/`fakef11`（形状正确的垃圾 blob）。材料语义同步更名：协议/契约/SDK 的 `encrypt_username|encryptUsername` → `username`（申请人 wxid，来自 37 卡片 `fromusername`；卡片 V3 encryptusername 仅保留在 friend-requests 预检 `hasV3`）；interfaces 三清单 + native.generated.ts（生成器字节级重生成）+ SDK 已手工同步，`pnpm interfaces` 门禁待 Linux CI 复核。待部署环境跑第一层探针矩阵验证 f5/f6/f7/f11 必要性；UI 通过按钮挂接随后。

## 8. 下一步（按序）

1. **hub encode 重写**（`wechat-protocol/src/verify_user.rs`）：按 §3 官方形状——opcode=3、scene=1、field4=[VerifyUser{f1:申请人 wxid 明文, f2:v4 ticket 原样}]；`WX_VERIFY_PROBE=official*` 系列开关覆盖字段增删变体。
2. **灰度探针矩阵**（部署环境，材料来自 friend-requests）：逐项验证 f5/f6/f7/f11 必要性——
   - minimal：base + opcode=3 + scene=1 + field4[{f1,f2}]（核心假设）
   - +f7=[申请scene] → +f6=1 → +f5="" → +f11（若 hub 无法生成 blob 则跳过并记录验证缺口）
   - 收敛判据：ret=0；每轮前开门 gate、清 marker（见 grey-probes §9 流程），验证后关门。
3. 若 minimal 被拒且追加 f5/f6/f7 仍被拒 → f11 blob 必需，转静态定位客户端 blob 生成函数（§6 第 1 条调用链），或记录验证缺口交维护者评审。
4. 形状收敛后：gate/频控/幂等回归 → `pnpm interfaces` + Linux CI 复核 → 更新本文 §7 与 [protocol-mapping README](README.md)。

## 9. Windows 4.2.0.13 动态取证记录（2026-11-17 晚）

> 目标二进制：`C:\Program Files\Tencent\Weixin\4.2.0.13\Weixin.dll`（205,943,848 B，SHA-256 `afe3d02c58bada3c…`，image base 0x180000000，RVA=VA-0x180000000）。
> 与旧分析构建（`d733489e…`，204,168,240 B）不同——偏移全部重新定位后使用。

**静态重定位（capstone + numpy rip-relative 全相位扫描 + 全名函数字面量反查 vtable）**：

| 类 | vptr（对象首 qword，= slot0 析构槽） | GetFullName | New(slot2) | parse(slot7) | ByteSizeLong(slot8) | serialize(slot9) |
|---|---|---|---|---|---|---|
| VerifyUser | 0x98372b8 | 0x3c12970 | 0x3c11420（alloc 0x88） | 0x3c116f0 | 0x3c124b0 | 0x3c121b0（首指令读 [rcx+0x80]） |
| VerifyUserInfo | 0x9837338 | 0x3c12bf0 | 0x3c12ba0（alloc 0x20） | 0x7cd420 | 0x7cd5f0 | 0x7cd5a0（读 [rcx+0x1c]） |
| VerifyUserRequest | 0x98373b8 | 0x3c14da0 | 0x3c13670（alloc 0xa0） | 0x3c13890 | 0x3c147d0 | 0x3c14550（读 [rcx+0x98]） |
| VerifyUserResponse | 0x98374d8 | 0x3c162c0 | 0x3c15770（alloc 0x48） | 0x3c15970 | 0x3c16060 | 0x3c15f40（读 [rcx+0x44]） |

- CGI 137 复确认：路径字符串 xrefs → `0x181a66667` / `0x181a7a590` 两处 `mov dword [...], 0x89`（getcontact 对照 `0xb6`）；栈描述符形态与 Linux glue 一致（path size 0x20 + movups 装载）。
- 布局与旧构建一致（hasbits 偏移、对象大小全部吻合），字段表直接沿用 §2；**Windows ABI 差异**：f4 为元素指针数组（非内联元素数组）、count 为 u32（+0x20/+0x24=count/cap）、字符串成员为指针（空串指向共享单例）。
- **多进程注意**：仅主 `Weixin.exe` 加载 Weixin.dll（辅助 Weixin.exe 均无），hook 主进程即可。

**动态链路（accept 全链，ret=0）**：`biz.big 0x1a661e0`（写 0x89 的业务函数）→ `glue.small 0x1a7a550`（端点提交 glue，请求对象经 rdx 传入）→ 通用序列化 `0x14808e ← 0x35f635` → 服务器；响应 parse `0x3c15970`。业务上游调用链：`0x1a6888d ← 0x1a75a3a ← 0x17ccf41 ← 0xdd358a ← 0x4ab74a ← 0x4aa70f ← 0x76b5b60 ← 0x687f040`。

**捕获基础设施**（可复用，均在 `%TEMP%\wx-reverse\weixin-capture\`，不入仓库）：`scan_offsets2.py` / `inspect_dll.py` / `finalize_offsets.py`（偏移）、`hook_verifyuser.js` + `drive_verifyuser.py`（Frida v3：serialize 主捕获 + New/MergeFrom 源对象 + glue/biz 入口 + 响应 parse）、`decode_v3.py`。dump 产物含 ticket/材料明文，只存 `%TEMP%\wx-reverse\weixin-capture\dumps\`。
