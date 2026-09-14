# 团队1 投递可靠性 — TEAM-REPORT

- worktree：`/data00/home/huangyuhang.edu/ai/botmux/.worktrees/fb-submit`
- 分支：`fb/submit-delivery`（基线 `ad184ae3` = 最新 origin/master）
- 范围：契约 §2 团队1 的 C（submit 失败现场分类）、B（TRAE/OpenCode ready 闸门）、E（活跃度诊断，轻量并入 C）
- 明确不做：A（受控重贴，重复执行风险，独立 PR）、D（菜单按钮桥）、通用 AI 屏幕识别

## 1. 特性清单

### C — submit_unconfirmed 发卡前失败现场分类（对应评估 R4）

- 做了什么：新增纯函数服务 `src/services/submit-failure-diagnosis.ts`，在 `submit_unconfirmed` 用户卡发出前对当前屏幕 + PTY 活跃度做证据分级，给出可操作分类：
  - `logged_out`（屏幕证据）：登录/鉴权门（waiting for login / please run /login / Sign in to … / Unauthorized / 401·403 与鉴权词共现）；
  - `interactive_menu`（屏幕证据）：键盘选择界面（hooks need review / Legacy TraeCode 迁移 / Replace goal? / Update now / Press enter to continue / trust the files / 行首编号光标）；
  - `draft_parked`（屏幕证据）：正文停在 composer 的 `[Pasted Content N chars]`；
  - `still_active`（活跃度弱证据）：屏幕无门但 20s 内有新鲜 PTY 活动，只触发有限额外静默，不用于下结论；
  - `unknown`：维持原卡。
  - 优先级：屏幕门 `logged_out > interactive_menu > draft_parked` 优先于活跃度时钟；屏幕文本统一复用 `stripAnsiScreenText` 清洗。
- 行为变化（仅限非 ZMX 后端的用户卡文案与有限静默）：
  - 三类屏幕门命中时改发对应 `submitDiag.*` 卡（zh/en，明确"消息没进模型"+ 具体动作：登录 / 完成选择或 Esc / 按 Enter）；
  - `still_active` 在既有 2 次弱证据重查之外，最多再静默 3 次（约 +60s，链总上限约 120s），复用既有 `armDeferredRecheck()`，无裸定时器；静默路径不丢 bridge mark、不发 durable terminal；
  - ZMX 屏幕几何非权威：完全不读屏，卡文案/时序与旧行为逐字一致；
  - `emitDurableTerminal('submit_unconfirmed')` 错误码、`dispatchAttempt` 守卫、全部既有插值参数不变；`submit-failure-chain.ts` / `submit-confirmation.ts` 判定零改动。
- 影响面：所有 CLI 适配器的非 ZMX 提交确认路径（Pty/Tmux 权威屏幕后端）；ZMX 与话题/群/p2p/adopt 各会话类型的 durable 终态语义不变；Linux/macOS 纯字符串判定，无平台分支。

### E — 活跃度/存活诊断（轻量并入 C）

- 做了什么：不另起模块。`still_active` 分类即 E 的同源合并，时钟来源与 worker 既有 `lastPtyActivityAtMs` 一致；真终态仍由既有 chain 的 generation/attempt fence 取消，额外静默只是保险上限。
- 明确未做：评估 E1 中 `worker-pool.ts` 的 `input_delivery_failed` 心跳卡（worker 死亡/投递层心跳）属团队2 的 worker-pool/2.1 万行区，本轮未碰，列入协调项。

### B — TRAE 骨架屏启动闸门 + OpenCode 首条静止窗口（对应评估 R2）

- B1 TRAE：真机校准（node-pty + xterm-headless 采样本机 traex 二进制）确认 traex 0.205.1-alpha.3 冷启动 0.6s 帧已画出 `❯ Ask TraeCode CLI …` 与 `100% context left`（两者都命中现有 readyPattern）但 banner 仍是 `model: loading`，1.5s 帧 model/directory 两格才解析；0.201.1-alpha.6 banner 同构。traex 是 codex fork，直接为其补上与 `codex.ts` 逐字一致的 `startupPendingPattern` / `startupReadyPattern`；traex 本就有 `deferFirstPromptTimeoutUntilReady: true`，故 worker.ts 零改动，首条软/硬超时自动等待该闸门。
- B2 OpenCode/OpenCode2：两者 Bubble Tea TUI 无可靠 prompt 锚（`readyPattern: undefined`）。新增适配器可选字段 `firstPromptQuiescenceMs`（仅对无 readyPattern 的适配器、且仅本 spawn 首次 idle 之前生效），两适配器置 4000ms；首次贴入前等 4s 静止，冷启动/resume→fresh 不会贴进启动中的 TUI，之后所有周期恢复既有 2s。IdleDetector 的 startup hold、spinner guard(3s)、static-busy latch、completion 500ms、readyPattern 策略2 提前返回全部未动。
- 影响面：公共 `IdleDetector` 与 3 个适配器文件；对有 readyPattern 的 CLI（codex/coco/claude 等）结构上无行为变化（长窗口条件要求 `!readyPattern`，codex 另有 startup gate）；跨 Pty/Tmux 后端等价（只消费 PTY 文本流）；无平台分支。

## 2. 改动文件表

| 文件 | 新增/修改 | 特性 | 是否跨团队热点（契约 §3） |
|---|---|---|---|
| `src/services/submit-failure-diagnosis.ts` | 新增 | C/E | 否（独立 service） |
| `src/worker.ts` | 修改（+40 行，仅 import 1 行 + 常量/计数器各 1 + 发卡前 1 个分类块 + t() key 分叉） | C/E | 是：仅动约 1.1 万行 submit 发卡接线；未进入约 1.4 万/2.1 万行区，未重排相邻代码 |
| `src/i18n/zh.ts`、`src/i18n/en.ts` | 修改（各尾部追加 3 key，零编辑既有 key） | C | 是（i18n 共用）：仅追加 `submitDiag.*` |
| `src/adapters/cli/traex.ts` | 修改（+12 行，仅 2 字段 + JSDoc） | B1 | 否 |
| `src/adapters/cli/types.ts` | 修改（+12 行，仅 1 可选字段 + 文档） | B2 | 否 |
| `src/adapters/cli/opencode.ts`、`src/adapters/cli/opencode2.ts` | 修改（各 +4 行，仅 1 字段 + 注释） | B2 | 否 |
| `src/utils/idle-detector.ts` | 修改（+22 行：1 个一次性 latch + 策略2 延时选择） | B2 | 公共 ready 路径，已跨 CLI 回归 |
| `test/submit-failure-diagnosis.test.ts` | 新增（38 tests） | C/E | 否 |
| `test/submit-diag-wiring.test.ts` | 新增（7 tests，源码 pin） | C/E | 否 |
| `test/traex-startup-readiness.test.ts` | 新增（9 tests，真机帧固件） | B1 | 否 |
| `test/opencode-first-prompt-quiescence.test.ts` | 新增（2 tests） | B2 | 否 |
| `test/idle-detector.test.ts` | 修改（makeCli 加可选入参 + 新增 5 tests，既有用例零改动） | B2 | 否 |

未改：`package.json`、`bun.lock`、`src/services/submit-failure-chain.ts`、`src/services/submit-confirmation.ts`、任何 `core/**`、`worker-pool*`、其它适配器。

## 3. 验证命令与结果原文

### build（worktree 内，合并树）

命令：`bun run build`

结果（末尾原文）：

```
[build-audit] retired Workflow v2 artifacts absent
[audit-embed] 13 dist asset(s) accounted for (compiled-binary reachability decided)
[audit-embed] no source site reads an asset from a module-relative path
BUILD_EXIT=0
```

tsc / typecheck:scripts / typecheck:test-mocks 全过，无 `error TS`。
备注：两个 subagent 在冷 worktree 首次 build 各遇到过一次 `generate-runtime-build-id.mjs` 的 `ERR_MODULE_NOT_FOUND dist/utils/runtime-build-id.js`，原样重跑即过、不可复现，失败点不在 tsc 与本次改动路径（unverified，疑似冷树一次性产物竞态）；lead 本人在最终合并树上的完整 build 一次通过。

### 目标测试（lead 在最终合并树统一复跑）

命令（17 文件）：

```
bunx vitest run test/submit-failure-diagnosis.test.ts test/submit-diag-wiring.test.ts \
  test/submit-unconfirmed-wording.test.ts test/submit-failure-lifecycle-wiring.test.ts \
  test/submit-confirmation.test.ts test/submit-failure-chain.test.ts test/submit-notification.test.ts \
  test/idle-detector.test.ts test/codex-startup-readiness.test.ts test/traex-startup-readiness.test.ts \
  test/ready-gate.test.ts test/traex-adapter-submit.test.ts test/opencode-resume.test.ts \
  test/opencode2-resume.test.ts test/opencode-busy-state.test.ts test/opencode-raw-passthrough.test.ts \
  test/opencode-first-prompt-quiescence.test.ts
```

结果原文：

```
 Test Files  17 passed (17)
      Tests  310 passed (310)
```

关键文件用例数：submit-failure-diagnosis 38、submit-diag-wiring 7、submit-unconfirmed-wording 15、submit-failure-lifecycle-wiring 10、submit-confirmation 17、submit-failure-chain 15、submit-notification 2、idle-detector 84、codex-startup-readiness 13、traex-startup-readiness 9、ready-gate 14、traex-adapter-submit 10、opencode-resume 31、opencode2-resume 29、opencode-busy-state 12、opencode-raw-passthrough 2、opencode-first-prompt-quiescence 2。

### 公共 ready/适配器路径的跨 CLI 补充回归

`grep -rl "startupPending|firstPromptQuiescence|deferFirstPromptTimeoutUntilReady|isStartupPending" test/` 另命中 3 个文件，补跑：

```
bunx vitest run test/cli-adapters.test.ts test/dsh-tui-adapter.test.ts test/input-gate.test.ts
 Test Files  3 passed (3)
      Tests  490 passed (490)
```

合计本轮在合并树验证 20 个测试文件、800 tests 全绿；build exit 0。两类新逻辑均为 TDD（先写合成/针对性测试看红灯，再实现）。未跑 vitest 全量（契约 §5：全量并行有已知 flaky），以上为定向文件集；无单文件复跑需求（一次跑全绿）。

## 4. 风险点、明确未做项、需整合者协调

### 风险点

1. **屏幕分类依赖可见文本**：规则按真机/评估固件校准，但未来 CLI 改文案可能漏判（回落 `unknown` = 原卡，安全侧）。误判方向上，登录/菜单词均取较强字面并对 401/403 要求与鉴权词共现；已加 traex loading 骨架屏、裸 403、普通代码 diff 等负例防误报。菜单规则中的 `update now` / `press enter to continue` 为短语，若某 CLI 在正常输出中逐字出现可能归为 interactive_menu（仅卡文案不同，不改变投递行为，风险低）。
2. **still_active 额外静默使用全局 `lastPtyActivityAtMs`**（非 per-turn baseline；接线时刻 worker 作用域内可直接取得的同源时钟）。与 settlement 内 `submitActivityEvidenceSince(activityBaseline,…)` 的作用域弱证据口径不同，是有意的"无门 + 全局刚有活动就多等一轮"保守策略；有 3 次硬上限 + chain fence，不会无限延后卡片。
3. **OpenCode 首条多等 2s**：冷启动首条最坏延后 2s（2s→4s 静止），仍在既有首条 15s 软/90s 硬超时之内；仅首次，后续周期不变。
4. 未做飞书真机/截图验证（契约 §5 要求留给整合者统一安排 live 阶段）；TRAE 帧来自本机真机 PTY 采样，OpenCode 行为为单测 fake-timer 验证。

### 明确未做项

- A 受控重贴（重复执行风险，独立 PR）。
- D 菜单按钮桥、通用 AI 屏幕识别。
- E1 的 worker-pool `input_delivery_failed` 心跳/worker 死因卡。
- composer_empty 分类：评估枚举中的 `composer_empty` 与 A（重贴/空 composer 处置）强绑定，本轮不做 A，故不引入该类别。

### 需整合者协调

1. **E1 → 团队2**：`src/core/worker-pool.ts`（及 worker.ts 约 2.1 万行 uncaughtException 区）的投递层心跳/worker fatal 卡是团队2 范围，本轮完全未碰；C 的 `still_active` 只覆盖"worker 活着、CLI 疑似还在动"的 PTY 侧，与 worker 进程死亡死因互补，整合时两侧文案/错误码注意不要重复发卡。
2. **worker.ts 合并**：本团队仅在 `scheduleSubmitFailureNotify`（约 1.11 万–1.14 万行）内追加，与团队2 的约 1.4 万/2.1 万行区在函数级不相交，预期文本合并无冲突。
3. **i18n 合并**：仅尾部追加 `submitDiag.logged_out` / `submitDiag.interactive_menu` / `submitDiag.draft_parked`（zh/en 同步），未占用其它团队前缀。
4. 真机验证（尤其 traex 冷启动首条、OpenCode resume→fresh 首条、三类诊断卡实际观感）建议整合者在统一 live 窗口安排。

## 5. 自测结论

两个并发 general-purpose subagent 按不相交文件子集 TDD 实现；lead 已对全部多文件 diff 做独立 review（分类优先级/证据分级、ZMX 不读屏、静默上限与 chain fence、ready 闸门对 codex/coco/opencode 三类互不误伤、worker.ts 仅发卡区一处 hook、i18n zh/en 同步且 en 渲染无 CJK、测试断言未放水），并在最终合并树亲自跑通 `bun run build`（exit 0）与 20 个目标/回归测试文件（800 tests 全绿）。C/B/E 三项按契约范围完成，未越界，未碰 live daemon，未 push/PR/tag；探针临时产物（882M）已清理。
