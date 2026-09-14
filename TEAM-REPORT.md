# TEAM-REPORT — Team 2（会话生命周期 / PTY-tmux 后端 / 守护进程）

分支 `fb/session-backend`（worktree `.worktrees/fb-backend`，基线 `ad184ae3`）。
P1 / P3 / P5 全部交付，P4 本轮不做（见 §4）。未 push、未开 PR、未打 tag。

提交（本地三个特性分开）：

| commit | 特性 |
|---|---|
| `ddaecd11` fix(dashboard): 空闲清理纳入 dormant 会话并拆分空闲/休眠计数 | P5 |
| `b81e1667` feat(tmux): clone3 EPERM 分类文案与 tmux 版本能力门控 | P3 |
| `dc6b42bd` feat(worker-pool): worker 死因经有界 stderr 环与 IPC 上卡片 | P1 |

## 1. 特性清单

### P1 worker 死因上卡片（反馈 022/030/072/100a/132/214/239/243，根因 C1/C3）

做了什么：

1. **per-worker 有界 stderr 环**：200 行 / 8192 字符硬上限；`[botmux-worker-error]`
   标记行单独有界（20 行 / 2048 字符）并在渲染时置顶；随 fork 闭包存活、worker
   退出后被 GC，无全局注册表。ANSI 清洗复用 `src/utils/crash-log.ts`。
2. **两张卡片带死因**：crash-loop 熔断卡仅在 worker 未给 `logTail` 时补环尾
   （10 行 / 1500 字符；有 logTail 时维持现状不重复）；preReadyExit 卡追加 8 行
   环尾，仍只发一次 `notifyStartupFailure`。熔断阈值 / 重启计数一字未动。
3. **worker_fatal IPC**：`worker.ts` 的 `uncaughtException` / `unhandledRejection`
   退出前 best-effort `sendAndFlush`（一次性、截 4096 字、1s flush、失败吞掉不阻塞
   fail-close 退出）；daemon 侧记录 error 日志并作为标记行钉入环。`isIgnorableStreamError`
   早退与原 teardown 顺序保持不变。
4. **tmux pipe pane 死因捕获**：pipe-pane 终局失败后 best-effort 各执行一次
   `display-message -p '#{pane_dead}:#{pane_dead_status}'` 与 `capture-pane`
   （各 1000ms 超时、`tmuxEnv()`、任何异常 → 证据不确定）。确认 pane 内 CLI 即退时
   把错误改写为「pane 中的进程启动后立即退出（exit status=N）……CLI 本身启动失败，
   而不是 tmux 未安装 + 最后一屏 + 原始错误首行」；探测不确定（含 server 级故障、
   pane 已消失）时**静默退回原始错误**。`isRetryableStartupTmuxFailure` 与重试循环不变。

影响面：ring+IPC 对 Pty/Tmux、话题/群/adopt、Linux/macOS、沙盒 on/off 行为无差异；
capture-pane 仅 TmuxPipeBackend（含 persistent pane 同路径）。

### P3 tmux 错误分类 + clone3 EPERM 文案 + 版本门控（反馈 032/132/203a/243，T037 兼容，C1/C3）

做了什么：

1. **EPERM/clone3 分支**：`childFailureReason` 在 ENOENT 之前判定 `code==='EPERM'`
   或 stderr/message 含 `clone3` / `operation not permitted`，文案明确「tmux 已安装，
   容器 seccomp/沙箱禁止 clone 进程克隆」。新增 `classifyTmuxProbeFailure`
   （`env-denied` / `missing` / `generic`，不确定一律 generic）。
2. **门禁卡按分类渲染**：tmux + env-denied 只给 seccomp 放行与 `BACKEND_TYPE=pty`
   应急说明（含「PTY 不跨 daemon 重启存活」），**不出现任何安装命令**；missing 仍给
   brew/apt 安装指引，generic 维持现状；非 tmux 后端不走该分类。
3. **版本能力门控**：`parseTmuxVersion`（忽略字母后缀，解析失败 null）+
   `getTmuxVersionCached`（成功进程内缓存；失败只缓存 10s；3000ms 超时；绝不抛错）+
   `tmuxVersionAtLeast`（null → false）。resize：已知 <2.9 回退 `resize-pane`，
   null/≥2.9 保持 `resize-window`；`window-size largest` 仅在 null 或 ≥3.1 执行
   （pipe-backend spawn 与 tmux-backend adopt 两处同步）。版本不可解析 = 行为不变。
4. **read-isolation unknown 卡**：追加操作指引（不要 kill-server、后端恢复自动重探、
   可稍后重发消息）。**fail-close 默认未翻转**，拒绝逻辑零改动。

影响面：文案仅 tmux 门禁/持久 pane 场景；版本门控仅 tmux 后端全场景；Linux 容器主战场，
macOS 自装旧 tmux 同样受益；Pty 无相关调用。

### P5 T292 清理谓词纳入 dormant + 语义明示

做了什么：

1. 清理谓词接受 `idle | dormant`：`isDormantCleanupCandidate` 复用 idle 全部安全排除项
   （locked / pendingRepo / tuiPromptActive / agentAttention），额外要求 `webPort`
   为空且满足同一空闲时长阈值；`selectCleanupCandidates` 返回 `{idle, dormant}`。
2. 清理执行两组并集，逐行走同一 close 端点；dormant 行的 pane 回收复用既有
   `destroyUnregisteredPersistentBacking`（tmux/herdr/zellij kill 后删记录，
   adoptedFrom / queued 跳过）——**先回收后端、再删记录**。WYSIWYG 不变：端点按
   sessionIds 再跑一遍谓词。`src/dashboard.ts` 因此无需改动（已核实端点 :4285-4337
   现有链路满足要求，且不触碰团队 4 的 6.2-6.6k 区域）。
3. sessions-page popover 拆为「空闲 N · 休眠 M」并增加语义说明段（含「/adopt 外部
   会话不会被关闭」）；总数 N+M 驱动空态/禁用；请求体与端点不变。
4. i18n 仅追加 `cleanupDormant.*` 三个键，zh/en 同步。

影响面：纯 dashboard + session-store，不经 CLI 后端通道；Pty/Tmux dormant 行均覆盖；
Linux/macOS 无差异。

## 2. 改动文件表

| 文件 | 新增/修改 | 跨团队热点 |
|---|---|---|
| `src/core/worker-stderr-ring.ts` | 新增 | — |
| `src/core/worker-pool.ts` | 修改 | 团队 2 主文件 |
| `src/worker.ts` | 修改 | **是（热点）**：仅两个 hunk——`:14007` read-isolation 文案、`:21192` fatal handlers；未进入团队 1 的 ~11k 提交卡区域 |
| `src/types.ts` | 修改 | **是（热点）**：仅在 `WorkerToDaemon` union 末尾追加 `worker_fatal` 一个成员 |
| `src/setup/ensure-tmux.ts` | 修改 | 团队 2 主文件 |
| `src/adapters/backend/session-backend-selector.ts` | 修改 | 团队 2 串行持有 |
| `src/adapters/backend/tmux-pipe-backend.ts` | 修改 | 团队 2 串行持有 |
| `src/adapters/backend/tmux-backend.ts` | 修改 | 团队 2 主文件（仅 :946 一处 3.1 门控） |
| `src/dashboard/session-cleanup.ts` | 修改 | 团队 2 范围 |
| `src/dashboard/web/sessions-page.tsx` | 修改 | **是（dashboard 热点，团队 4 邻近）**：仅清理 popover/计数选择器，未动其它视图 |
| `src/dashboard/web/i18n.ts` | 修改 | **是**：纯追加 3 键 |
| `src/i18n/zh.ts` / `src/i18n/en.ts` | 修改 | **是**：各纯追加 1 键 `workerDiag.recentStderr` |
| `test/worker-stderr-ring.test.ts` | 新增（12 例） | — |
| `test/crash-loop-diagnostic.test.ts` | 修改（+3） | — |
| `test/tmux-pipe-backend.test.ts` | 修改（+11） | — |
| `test/tmux-functional-probe.test.ts` | 修改（新增 EPERM/分类/版本用例，原 EMFILE 重试断言保留） | — |
| `test/backend-gate.test.ts` | 修改（+4） | — |
| `test/session-cleanup.test.ts` | 修改（14 例，+6） | — |

未触碰：`src/dashboard.ts`、`package.json`、`bun.lock`、团队 1/3/4 的其余文件。
未执行 `bun install`、`switch:here`、`use:here`、`daemon:restart`，未接触 live daemon。

## 3. 实际验证命令与结果

`bun run build`（tsc + 打包）在完整状态与 P3-only 中间状态各执行一次，均：

```
[audit-embed] 13 dist asset(s) accounted for (compiled-binary reachability decided)
BUILD_EXIT:0
```

vitest（单文件串行复跑；全量并行有已知 flaky）。最终全量状态：

| 测试文件 | 结果 |
|---|---|
| test/worker-stderr-ring.test.ts | 12 passed |
| test/crash-loop-diagnostic.test.ts | 9 passed |
| test/daemon-rejection-guard.test.ts | 11 passed |
| test/crash-log.test.ts | 6 passed |
| test/session-cleanup.test.ts | 14 passed |
| test/tmux-pipe-backend.test.ts | 65 passed（P3-only 中间态 60 passed） |
| test/tmux-pipe-backend-exit.test.ts | 11 passed |
| test/tmux-functional-probe.test.ts | 13 passed（P3-only 中间态同样 13） |
| test/backend-gate.test.ts | 34 passed |
| test/startup-tmux-gate.test.ts | 6 passed |
| test/tmux-probe.test.ts | 11 passed |
| test/web-terminal-tmux-window-size.test.ts | 1 passed |
| test/read-isolation.test.ts（跨影响） | 92 passed |
| test/dashboard-sessions-ui.test.ts（跨影响） | 42 passed |
| test/dashboard-i18n.test.ts（跨影响） | 5 passed |
| test/tmux-backend-env.test.ts（跨影响） | 71 passed, 5 skipped |
| test/worker-startup-retry.test.ts / -wiring.test.ts（跨影响） | 10 / 7 passed |

三个提交分别在各自提交内容下构建通过（P3 提交用 stash --keep-index 隔离验证：
build 绿 + 当态 7 个相关测试文件全绿；P1 最终态 build 绿 + 8 个相关文件全绿）。
测试断言未被削弱：审查发现并修正了两处 subagent 测试问题——被替换删除的
EMFILE 退避重试用例已原样恢复；backend-gate 中一处与需求无关的 zmx 用例文案改动
已还原。subagent 另做过变异验证（分类器改 generic、paneDead 改 false、resize
强制 window 均使对应新测试变红，恢复后转绿）。

独立 review：lead 逐行读完全部 src diff 与测试 diff（含三份 subagent 产出），
确认 unknown fail-close 未翻转、ring 有硬上限、capture-pane 失败静默退化、
dormant 清理确实先回收 pane、未越界热点文件、i18n 全部 append-only。

## 4. 风险点、未做项、协调清单

**已知限制**

- pane 死亡证据要求 pane 在 CLI 退出后仍可寻址；生产未配置 `remain-on-exit`
  （grep 确认 pipe/tmux 两个 backend 均无该选项），pane 被 tmux 一并销毁时
  display-message 失败 → 按设计静默退回原始裸错误。该特性只在「pane 还在但
  pane_dead=1」（如 command not found / 信号退出）时增强文案，不改变失败形状。
  若后续要覆盖 pane 即消失场景，需评估 set-remain-on-exit 的副作用，本轮不做。
- 证据探测超时取 1000ms/次（评估建议 200ms）：仅在「已经启动失败」的终局路径
  增加最多约 2s，正常路径零影响；取 1000ms 是为了兼容高负载容器里 tmux
  server 的调度延迟。
- 错误分类在渲染层对 reason 文本分类（`classifyTmuxProbeFailure`），未给错误
  对象新增 kind 字段：改动面最小，分类规则集中在一个纯函数并已单测；后续若
  P2 需要结构化 kind，可再把分类结果挂到错误对象。
- `worker_fatal` 的 worker 侧发送没有 spawn 级 e2e 测试（worker 启动无崩溃注入
  钩子，不为测试在 21k 热点区加 test-only 分支）；IPC 契约、daemon 侧标记钉环、
  环渲染均有单测，worker 侧仅 build + 代码审查保证。

**明确未做**

- P4（cgroup v1 内存口径 + FD 预警）：核心范围已全绿，但本轮不做，留待下一轮独立提交。
- P2 tier-2 暂停选择卡、R2 supervisor scope、fleet lease fencing：均不在本队本轮范围。
- read-isolation unknown 默认不翻转；熔断阈值（>3 次/60s）与重试次数不变。
- 未做飞书 live 验证（按任务约束未执行 daemon:restart）；合成路径已覆盖，
  真机 seccomp clone3 EPERM 与真机 pane_dead 场景留给整合者部署后验证。

**需整合者协调**

- `src/worker.ts` 两个 hunk（`:14007`、`:21192`）与团队 1 的 ~11k 区域不重叠，
  但同文件合并需各自 rebase；`src/types.ts` 是 union 末尾追加，冲突仅可能是并列追加。
- `src/i18n/zh.ts` / `en.ts` / `src/dashboard/web/i18n.ts` 全部 append-only
  新键（前缀 `workerDiag.*`、`cleanupDormant.*`），与团队 1/3/4 的 i18n 追加
  合并时并列即可；注意 zh/en 必须成对。
- `sessions-page.tsx` 改动在清理 popover 局部（计数选择器 + 说明段），团队 4
  若同文件有大改注意该区域。
- 部署验证建议：①容器 seccomp 下启动 tmux 会话看 env-denied 卡；②tmux 2.8/3.0
  主机上 resize 与 web 终端不再报 unknown command；③制造 worker 未就绪即崩
  （错误 CLI 路径）看卡片环尾；④休眠会话出现在清理 popover 的「休眠 M」且
  清理后 tmux 无残留 pane。

## 5. 自测结论

P1 / P3 / P5 全部完成，`bun run build` 通过，17 个相关/跨影响测试文件累计
424 个用例全部通过（含 5 个环境性 skip），边界约束（热点文件、fail-close、
阈值不動、append-only i18n、不碰 live daemon / 依赖锁）全部满足。P4 按约定缓做。
