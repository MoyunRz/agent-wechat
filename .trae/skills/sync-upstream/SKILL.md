---
name: sync-upstream
description: Sync the agent-wechat fork with upstream thisnick/agent-wechat by cherry-pick batches. Use when the user asks to merge, sync, catch up with, or pull upstream commits into the fork branch. Do not use for routine code review or new feature work.
---

# agent-wechat fork ↔ upstream 同步更新流程

把 upstream（thisnick/agent-wechat）的新提交合并进 fork 分支（origin = fork 仓库）。本地检出路径以 `git remote -v` 实际为准。

## 前提（决定了整个流程的形状）

- **两个仓库无共同祖先**：只能 `git cherry-pick -x`，**永远不要** merge/rebase upstream。
- origin 可能是私有仓库；upstream 是公开仓库，fetch 不受影响。
- 工具链：`cargo +1.93.1`（rust-toolchain.toml 钉死），需含 rustfmt + clippy。
- Shell 是 Windows PowerShell 5：**不支持 `&&` 和 heredoc**。多命令用分号，git 提交信息写进临时文件后 `git commit -F <file>`。

## 同步步骤

### 1. 拉取并列出上游新提交

```powershell
git fetch upstream --quiet
git log --oneline HEAD..upstream/main
```

### 2. 批次规划（关键，防语义空洞）

- 逐个读提交信息与 diff（`git show <sha>`），**先查依赖再挑**：用 `git log -S <符号> -- <路径>` 追符号来源；被选提交的 `-x` 尾注会记录 upstream 源提交哈希，可顺藤排查依赖链。
- **跳过已被包含的提交**：`git merge-base --is-ancestor <候选> HEAD` 为真则跳过。
- **cherry-pick 顺序 = upstream 实际历史顺序**（`git log --reverse`），不要按任务队列给的顺序反着挑——顺序反了会产生大量无意义冲突。
- 缺失的父提交会留下语义空洞（编译过但测试挂），规划阶段用 `-S` 把依赖提交一起补选。

### 3. cherry-pick 与冲突决策

```powershell
git cherry-pick -x <sha>
# 冲突解决后：
$env:GIT_EDITOR='true'; git cherry-pick --continue
```

冲突决策守则（按优先级）：

1. **生成文件**（`interfaces/*`）：任取一侧，收尾统一重新生成。
2. **本地刻意删除的子系统**（如 sticker 全家：wechat-profile/stickers.rs、wechat-media/stickers.rs、core/sticker_preparations.rs、UI stickers、相关文档）：保持删除，upstream 侧代码一律不恢复。
3. **upstream 早期形状**（未选批次带来的中间态，如 `UploadedImage.original` 的 Option、trait progress、函数重命名）：按**本地现行形状**融合，不引入中间态。
4. **本地运行时防护逻辑**（限流、退避、熔断、降级、门控、logout fence）：必须保留，upstream 若与之冲突按本地语义融合。
5. 语义冲突常不在冲突标记处，而在被删/被改的调用链上——修完后必须跑测试（见第 4 步）。

### 4. 语义回归检测

- 分类失败：**环境性失败**（本 Windows 机的已知清单，不要修）：
  - ffmpeg/ffprobe 未装 → `media::video` 全部、voice 相关、selected_normal_video
  - wxgf 解码器缺失 → concurrent_wxgf、wxgf_source
  - official_profile takeover（Linux-only）、saved_login、profile_network（unix 路径断言）、native_compat
- **真实回归**才是要修的：常见形态是"测试在、实现块在冲突解决中丢失"。用 `git log -S <符号> -- <文件>` 追符号最后出现的提交，与 upstream 源提交对照找回。
- 插桩注意：`#[cfg(test)]` 的 eprintln **只在测试所属 crate 自己的 test 构建里生效**；给依赖 crate（如 wechat-profile）插桩要临时去掉 cfg 标记，用完必删。

### 5. 提交前门禁（全部通过才算完成）

```powershell
cargo +1.93.1 fmt --all --manifest-path packages/native-client-rust/Cargo.toml
cargo +1.93.1 fmt --all --check --manifest-path packages/native-client-rust/Cargo.toml
cargo +1.93.1 clippy --workspace --all-targets --locked --manifest-path packages/native-client-rust/Cargo.toml -- -D warnings
cargo +1.93.1 test -p <涉及crate> --lib --locked --manifest-path packages/native-client-rust/Cargo.toml
pnpm interfaces        # 列表有变必须随 PR 提交；openclaw 列表在 Windows 走 shell 已修复
```

- 用户可见行为/包变更要加 `.changeset/*.md`；文档之外的仓库工具链修复不需要。
- **敏感扫描（推送前必做）**：对 `git diff origin/main..HEAD` 和工作树扫描：历史测试用过的真实账号/设备 ID 标记（具体值只在本地维护记录，不写入本仓库）、本地用户名与检出路径、真实 IP、SSH 用户名、token/密钥形态。命中即脱敏（占位符化），资料文档保留、只脱环境标识。
- `pnpm interfaces` 全量约 80-90s；`openclaw` 单列表可用 `node packages/openclaw-extension/scripts/interface-listing.mjs` 直接验证。

### 6. Windows 终端环境坑（省时间）

- 命令 10 分钟超时被杀；**编译与运行分开跑**：先 `cargo test --no-run`（可断点续传），再直接运行 `target\debug\deps\<crate>-<hash>.exe <过滤>`（用 `Get-ChildItem ... | Sort LastWriteTime -Descending` 拿最新二进制）。
- 后台任务会在同终端跑新命令时被杀；`Start-Process` 分离进程也活不过沙箱。挂后台后不要再执行其他命令，等通知。
- `git push` 的 stderr 进度在 PowerShell 里显示为 RemoteException，不影响成败，看 `feat/... -> feat/...` 行。

### 7. 推送与报告

```powershell
git push origin <branch>
git rev-list --count origin/<branch>..HEAD   # 确认为 0
```

完成后向用户报告：批次/提交清单、冲突与融合决策、测试结果（含环境性失败说明）、需 CI/Linux 复验项。

## 已修复过的坑（不要当成新 bug 重查）

- profile hardlink 缓存读取路径用 `Path::join` 在 Windows 产生 `\` 分隔符被 `valid_relative_path` 拒绝 → 已改为 `format!` 正斜杠（media.rs / media_payload.rs）。
- `scripts/interfaces/index.mjs` 用 `execFileSync('pnpm')` 在 Windows 因 .cmd 垫片 ENOENT → 已加 `runStep` 经 shell 派生。
- 合并冲突曾丢失 `download_on_route` 的 storage 字段块与 server-selected 大视频守卫 → 已按 upstream e9c0d386/83431d94 恢复。
