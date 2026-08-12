# Session Actor Core 实施设计（A0→A4 + C1→C4 + I1）

> 本文是 Session Actor 演进提案的**实施摘要**：只保留与已落地代码直接对应的设计决策与改动内容，
> 供 reviewer 与后续 Target-A roll-up、Target-B 的实施者对照代码阅读。
> 概念调研、术语校准、方案比较与 ROI 论证过程不在本文范围。

## 1. 目标与本步边界

Botmux 的 Session 天然具备 Virtual Actor 的全部特征：稳定逻辑身份（`sessionId`）、长寿命且大部
分时间空闲、状态变化需按会话串行、执行实例（worker + Agent CLI）可丢弃可重建。终态模型一句话：

> **mutation 只穿过每 owner 一个的 `SessionRuntime.submit`**（per-Session 串行 command lane +
> typed outcome）；query 走只读 `SessionProjection`；worker/CLI 是可重建的 Executor Activation，
> 代际由 runtime 统一围栏；存储是 lane 后面的一个 Adapter seam。

三步交付，每步独立可发布、独立回滚：

| 步骤 | 内容 | 状态 |
|---|---|---|
| 第一步（本次） | A0 census → A1 runtime shell → A2 代际围栏 → A3 per-Session lane → C1 普通 IM 消息一刀切换 | ✅ 本 PR |
| 第二步 | C2 Dashboard 命令、C4 scheduler producer、C3 projection/readiness、A4 activation/restore 生命周期与 I1 BotId 按各自 ROI gate 迁入同一入口 | ✅ 已完成 |
| 第三步 | per-bot SQLite durable store 离线演练与单向 cutover（Target-B），届时才把 ACK 升级为崩溃可恢复的 durable 承诺 | 后续 |

第一步明确**不做**：不改变 durability 承诺（所有 outcome 标注 `processLocal`）、不引入 SQLite、
不迁移 C2/C4 调用方、不分配独立 BotId（I1）；§1.2–§1.4 单独记录其后的第二步增量，
不得回写 §1.1 的 Stage-1 snapshot。

### 1.1 第一步 baseline 锁定（2026-08-11）

本节是第二步分支的可复现起点，也是第一步口径冲突的最终解释。第二步必须从**包含本节的提交**
切出。未跟踪的长篇提案继续承载 Target 推导、contract、AC/FI，PR 草稿只承载交付文案；两者都
不是第一步事实或分支基线。

- upstream base：`abe84a62777991f4a9423f445c02c92a16a5e4fc`；第一步实现锚点：
  `f4a1f7cd57d1fcc81b0a93ede33a8ce938241eba`。重放后的 15 个 feature patch 经 `range-diff`
  全部为 `=`，没有因 rebase 改写第一步语义。
- authority inventory：23 个 authority、1,393 条记录、1,401 个 mutation，文件 SHA-256 为
  `7d8ff6cc8c6a305f92d6880fac631b48ed74eafd9557c5877f96f3786363c004`。
- runtime coverage：已迁移 A1 keyed-trigger 21、C1 ordinary 93、A2 executor 62 个 mutation；
  第二步候选仍为 C2 128、C3 12、C4 33、A4 343，另有 retained 32 与
  `remaining-bypass` 677（合计 1,401）；I1 是独立 identity gate，不计入 mutation partition。
  coverage 文件 SHA-256 为
  `8dc3371be0f15f023298f34de0ee52474244496d79c7c6a178f1acf03ea493fb`。

“保持 Current persistence”锁定的是 **authority、ACK 与 durability contract**，不是禁止为行为等价
而扩展 Current schema。第一步只允许以下两个已落地、受 A0 台账覆盖的窄扩展：

1. `PendingRepoSetup.cliInput`：在既有 pending-repo/activation path-specific authority 内保存精确
   opening payload，确保暂存后仍投递同一个 C1 输入；它不是通用 mailbox。
2. `Session.lastInboundPreview`：供 Dashboard 重建消息预览的 presentation evidence；它不参与
   admission、lifecycle 或 executor truth。

两者都不创建新 authority，不改变 transport ACK 时点，不新增 replay/crash-durability 承诺，也不
授权第二步继续把任意字段塞进 Current row。本节的 Stage-1 snapshot 保持历史不变；第二步迁移导致
machine ledger/digest 变化时必须同步台账并重跑审计与合同测试，完成后新增独立的 Stage-2 baseline，
不得回写本节来伪装第一步从未变化；只有证明本节对第一步事实记录有误时才更正并留下显式说明。

### 1.2 第二步增量：C3 projection/readiness

C3 在不改变 Current authority/durability 的前提下建立一个 owner-scoped、可丢弃重建的 Dashboard
read model：`SessionProjection.read({ kind: 'dashboardSnapshot' })` 返回
`{ projectionEpoch, cursor, rows, readiness }`；snapshot 的 row rebuild 与 cursor capture 在同一
JS run-to-completion 段完成。Session event 由单一 EventBus 添加 process-local epoch/sequence，
Dashboard 遇到重复、乱序、gap 或 epoch 变化即丢弃增量并 authoritative replace 该 owner slice，
replace 同时删除该 owner 已消失的 stale row，并通知已连接的浏览器 projection 重取 aggregate
snapshot，而不是让它从不完整 delta 猜删除。

聚合缓存以 owner + sessionId 为内部 key；当既有 bare-sessionId consumer 遇到跨 owner collision
时 fail closed，不返回任一冲突 row 或 mutation route。worker exit 只投影为 `dormant`，daemon/SSE
heartbeat 失效只把 runtime 标为 `stale`，均不反向写 `closed`。daemon 在 restore 完成后先成功构建
初始 projection，再从 `restoring` 切为 `ready` 并释放 IPC mutation gate；`Current/v1` capability
明确不携带 Store Epoch/schema/topology，后者仍属于 Target-B。

### 1.3 第二步增量：C4 / A4 / I1

C4 让 scheduler 只生产 stable run identity 并提交 `scheduled.fire`；20 个 Session mutation 由
Current scheduler Adapter 收口，13 个 deadline/status/repeat projection mutation 保持 scheduler
store 自有，不冒充 Session lifecycle 或 durable dispatch receipt。

A4 以 registry + immutable BotId + daemon boot epoch 缓存唯一 activation coordinator，并与
`SessionRuntime` 共用 `currentSessionCommandLane` 的同一 owner/session 地址。lane 内只做
begin/resume/retire 短转换，`forkWorker` / `forkAdoptWorker` 及 Riff、Codex App、adopt、classic RPC
细节仍在 worker-pool provider Adapter 内执行。production caller cuts 覆盖 ordinary cold/adopt、
keyed fresh、pending-repo first-start、scheduler、restore（含 pending-repo/adopt）、terminal lazy wake、
doc watch/comment cold 与 card voice/retry；它们不再直接调用 worker provider。

- 同 request identity 的并发 activate singleflight；不同 identity 同 Session 串行，后到者观察
  live executor 并按自身 policy 转成 live send/refusal。`retryable` 不永久缓存，同 identity 可重试；
  completed duplicate 仍准确返回 `completed`，在途 join 返回 `joined`。
- backend `unknown` 与 executor acceptance response-loss 都绑定 exact owner Session 进入 sticky
  quarantine；普通 ensure 或不同 request identity 都不能再 fork。只有同 binding 的显式
  `reconcile(exists|missing)` re-probe 可清除 quarantine。
- terminal request identity 携带 persisted worker generation，同代 HTML/WS join 一次 wake；worker
  exit 后新 generation 可再次 wake。exit 只清 executor 并保持 Session `active`，不自动写 `closed`。

旧 A4 bucket 的 343 个 mutation 经重新分区：225 条记录 / 226 个 mutation 是上述
activation/restore/provider protocol；其余 117 个不是 activation——显式 lifecycle/control 53、
active-route maintenance 6、fresh Session creation 30、generation-precommit command creation 28——
分别回到 projection/`remaining-bypass`。保留的 direct-call class 只有 fresh creation、需要在 fork
前提交 executor generation 的 trigger protocol、provider 内部 recovery，以及该 A4 分区时尚待 C2
收口的显式 control lifecycle；其后的 C2 caller cut 见 §1.4，台账不会回写 343-site 历史分区或用
wrapper 把 remainder 伪装成 A4 migrated。

I1 为每个 active Bot 提供不可变 BotId；daemon host、SessionRuntime 与 activation coordinator
均使用同一 BotId + boot epoch，`larkAppId` 只留作 Current transport/owner partition Adapter key。

**2026-08-12 减负修订**：I1 最初以分配式身份控制面交付（注册表 + report/apply promotion +
启动闸门 + `botmux identity` 命令）。评审发现其唯一收益（换址保身份）在没有 rebind 语义的现状下
无法兑现，而成本（双权威漂移、needsPromotion 阻断、首启迁移、并发首启竞态）已实际发生，且当时
尚无任何落盘数据按 BotId 寻址。故 BotId 收敛为外部地址的纯推导函数
（`bot_` + sha256(kind\0id) 前 32 hex，见 `core/bot-identity.ts`），注册表与迁移机械整体移除；
运行时 BotId 类型与全部 `ownerBotId` 消费面不变。身份仍与展示名/secret/launch 参数无关；
若未来需要换址保身份，届时以只记例外的显式映射引入，deriveBotId 的 JSDoc 记录了这一边界。
Target-B 首次将 BotId 写盘前，本决策可零成本复议。

### 1.4 第二步 baseline：C2 Dashboard caller cut（2026-08-12）

本节锁定第二步完成后的 machine baseline；它新增在 §1.1 之后，不回写 Stage-1 历史。当前 authority
inventory 仍是 23 个 authority，共 1,400 条记录 / 1,408 个 mutation，文件 SHA-256 为
`3374b0f72cfbb2fd4293bd6621516aed930762602677dc7373fe65f19a6e983e`。coverage 精确分区为：

- migrated：A1 keyed-trigger 21、C1 ordinary 93、C2 `dashboard-control` 8、A2 executor 62、
  C4 scheduler 20、A4 activation 226、C3 projection 23；A1 store Adapter 与 A3 lane 另以零写点的
  structural binding 验收；
- retained：C4 scheduler projection 13、path-specific authority 32；
- remaining：C2 `remaining-control-bypass` 86、Target-A `remaining-bypass` 824。

以上合计恰为 1,408；coverage 文件 SHA-256 为
`bbc6bce123bfc47e9f95056275e6bb139e79e8689bf06e700a5cb08cbdfca2d5`。旧台账中的 `control=128`
是一个同时吞入 Dashboard route projection、command/card、daemon 与 shared provider 的粗 bucket，
不是“C2 已迁移 128 个写点”的事实。第二步把它拆成 exact Dashboard caller cut 与显式 direct
remainder；后者非零，不得以 production binding 或调用路径推断抹掉。

C2 对 17 条 caller-supplied mutation route 强制至少由 body/header 一处提供 operation ID，
双写时必须一致；
`GET /api/sessions/:sessionId/trigger-result` 没有 caller operation ID，而是以
`trigger-result-fault:${memTriggerId}` 派生稳定业务键，提交一次 `control.mutate` 收敛 post-barrier
fault。IPC caller 禁止直接触达 SessionStore、active registry、lifecycle、worker、cwd/title 等
Current capability；route 只穿过 epoch-stable Dashboard command client。该 client 先注册 operation
receipt，再解析 opaque Session address；stale address 只允许有界重解析，dispatch response-loss 进入
sticky unknown/quarantine，同 identity 重试读取同一 receipt。

`SessionRuntime` 分别拥有 `control.mutate` 与 `control.rename` policy kernel：begin/resume 是 lane 内同步
短转换，provider effect 在 lane 外 await，settlement 再回同一 Session lane。applied/unknown receipt
保留到 daemon epoch 结束，不进入普通 transport 的 bounded eviction。Current control、scheduler、
ordinary/relocation、keyed trigger 与 reopen scratch cleanup 共用一个 route-admission authority；四个
producer 共七个 reservation call。reopen 从 admission、scratch retirement、reactivation 到可选 wake
始终持有同一 token，且 control 与 Runtime 复用 A4 的 BotId + boot-epoch activation coordinator。

authority selector 只承认 Current adapter 中可独立归属的 8 个 syntactic site：Dashboard route inspect、
relocation target inspect、control execute / async-trigger fault convergence，以及 Dashboard opening
barrier。`session-cwd#assignWorkingDirectory` 同时服务 Current sync 与 legacy `repinSessionWorkingDir`，
census 无法按调用路径拆分同一写点，因此整个 shared provider 留在
`remaining-control-bypass`；若以后需要迁移，必须先抽出 Current 专用 publisher，不能在 ledger 中
伪造归属。

外层 Dashboard create-session 与 idle-cleanup fixed-batch host、浏览器 semantic operation coordinator、
Sessions 卡片 operation ID 是 transport seam，不是 Session authority selector。它们仍受结构审计约束：
create/idle 父 receipt 保留到 Dashboard process epoch，idle retry 固定首轮 candidate batch 与 child ID；
浏览器复用 retryable identity 并隔离 unknown；卡片回调验证并透传渲染时生成的 stable operation ID。

## 2. 对实现有直接约束的设计原则

1. **引入 Virtual Actor 语义，不引入 Actor 平台**。Session 是唯一核心 Actor；不因某模块有后台行为就把它也建模成 Actor。
2. **状态 transition 串行，长时间工作并行**。lane 内只允许同步短转换；模型、CLI、Lark、filesystem、网络 I/O 一律在 lane 外。
3. **未知状态不是失败，也不是不存在**。ownership、backend、effect 不确定时进入 `ambiguous/quarantined`，禁止抢占和盲重放；不能用 `false`/throw 抹平 provider outcome unknown。
4. **Projection 不拥有 lifecycle truth**。Dashboard/IM 卡片可以延迟、重复或重建；worker/heartbeat 消失不写 `closed`。
5. **mutation 与 query 各穿过一个深 Interface**。调用方只依赖 `SessionRuntime`/`SessionProjection`；store、lane、activation、代际、backend probe 都是内部实现。
6. **Actor Core 与 durable store 分层验收**。本步保持 Current authority topology、ACK point 与
   durability guarantee，只允许 §1.1 的 scoped evidence 白名单，不冒充 crash-durable。

## 3. 模块结构与代码映射

### 3.1 核心 runtime（新增）

| 模块 | 文件 | 职责 |
|---|---|---|
| SessionRuntime | `src/core/session-runtime.ts` | `submit` 单一 mutation 入口；typed outcome；四类命令各自独立的 replay policy kernel |
| Executor runtime | `src/core/session-executor-runtime.ts` | executor 回调经 opaque lease + exact generation fence 收口；exit 三态分类 |
| Command lane | `src/core/session-command-lane.ts` | per-Session 同步短转换 FIFO；跨 Session 并行；结构性禁止 lane 内 await 长 I/O |
| Store seam | `src/core/session-store.ts` | `load/apply` + opaque `StoreVersion`；CurrentSessionStore 与 in-memory fault Adapter 共享同一套 contract suite |

### 3.2 Current 绑定层（`current-*` 前缀，SQLite cutover 后可整层删除）

| 模块 | 文件 | 职责 |
|---|---|---|
| runtime host 绑定 | `src/core/current-session-runtime.ts`、`current-session-executor-runtime.ts`、`current-session-command-lane.ts` | 把 runtime 组装到 Current store/daemon 环境 |
| 普通消息 ingress | `src/core/current-ordinary-ingress*.ts`、`current-ordinary-im-turn.ts` | C1 入站→物化→投递提交面（见 §5） |
| route/开话题 | `src/core/current-ordinary-route-registry.ts`、`current-ordinary-route-opening-production.ts` | route resolve、并发 create 单赢家、opening 首开语义 |
| pending-repo | `src/core/current-pending-repo-completion*.ts`、`current-pending-worktree-preparation.ts` | 选仓/auto-worktree 首启与 follower 暂存 |
| keyed trigger | `src/core/current-keyed-trigger-turn.ts` | `/api/trigger` at-most-once 语义（`reserved→attempting` barrier） |
| activation | `src/core/session-activation-runtime.ts`、`current-session-activation.ts` | BotId/epoch singleflight、lifecycle revision、typed reconcile/quarantine；worker-pool 只作 provider Adapter |
| scheduler | `src/core/current-scheduled-fire.ts` | stable firing 经 `scheduled.fire` 进入 Runtime，worker dispatch 复用 owner activation coordinator |
| Dashboard command client | `src/core/current-dashboard-session-command-client.ts`、`dashboard-ipc-server.ts` | stable operation receipt、opaque address 解析、route/external Session 命令单一提交面；IPC 只做 transport/auth/typed response |
| control / route opening | `src/core/current-session-control.ts`、`current-dashboard-route-opening.ts`、`current-dashboard-host-maintenance.ts`、`current-dashboard-chat-rename.ts` | control staged transition、Dashboard spawn/maintenance/rename Current effect；共享 A4 coordinator，不向 caller 暴露 store/registry/worker |
| route admission / scratch retirement | `src/core/current-route-admission.ts`、`current-reopen-route-admission.ts`、`current-route-scratch-retirement.ts` | ordinary/scheduler/keyed/relocation/reopen 共用 route reservation；reopen scratch 只凭 held token + exact owner binding 退休 |
| IM 侧生产注入 | `src/im/lark/current-ordinary-ingress-daemon.ts`、`current-ordinary-ingress-production.ts` | Lark 物化上下文、daemon 拥有的副作用注入点（卡片轮转、受理 reaction、失败提示等） |

### 3.3 A0 census 与构建期审计 gate

- `docs/architecture/session-authority-inventory.json`：源码 AST 推导的全量 Session/DaemonSession
  写点台账，每个写点分类为 `session_owned_persisted` / path-specific authority / `ephemeral_runtime`
  / `projection`，并记录 authority owner 与 access lane。`pnpm audit:session-state` 在构建期重新
  推导比对，未分类或漂移即失败（`--update` 后需人工分类）。
- `docs/architecture/session-runtime-coverage.json`：Target-A 可执行覆盖台账。按 coverage 条目
  钉住已迁移边界的写点 digest 与 production binding（含 forbidden-calls 扫描），`remaining-bypass`
  条目如实列出尚未归入具体 milestone 的 Target-A shared/direct-writer remainder。§1.1 的 Stage-1
  snapshot 保持 1,393 条记录 / 1,401 个 mutation；当前 Stage-2 census 是 1,400 条记录 / 1,408 个
  mutation，coverage 精确分为 keyed 21、ordinary 93、Dashboard control 8、remaining control 86、
  executor 62、scheduler 20 + retained 13、activation 226、path-specific retained 32、projection 23 与
  remaining 824。各 bucket 不能重复计数；C2 migrated selector 不允许 whole-file 或 caller-path 冒领。
  `pnpm audit:session-runtime` 构建期校验。
- 两份台账均有变异测试防腐化（oracle 测试篡改 selector、route identity、capability fence、共享
  admission、Runtime/A4/transport binding 后断言审计必须报警）。

## 4. 执行语义

### 4.1 命令四类与 replay policy

`submit` 不把命令扁平化为 generic union；四类命令各有独立 policy kernel：

| Policy | 适用对象 | crash/retry 行为 |
|---|---|---|
| `replayable` | 尚未越过外部 effect barrier 的 ingress | 同 idempotency key 重投返回同一 logical result |
| `reconcile-first` | CLI input、卡片 create/update 等可能已生效的 effect | 先按 stable identity reconcile；未知进 `ambiguous`，不盲重放 |
| `at-most-once-dispatch` | keyed `/api/trigger`（已提交 `reserved→attempting` barrier） | `attempting` 后 crash 收敛为 `dispatch_unknown`，永久禁止普通 redispatch |
| `terminal` | 已有 terminal receipt 的命令 | retry 只读回 receipt |

C2 的 `control.mutate` / `control.rename` 使用 reconcile-first + terminal receipt：外部 effect 返回前不
宣称 applied，effect throw/response-loss 固化为 unknown 并阻断盲重放；只有明确 retryable 的 pre-effect
拒绝释放 operation receipt 供同 identity 重试。`dashboard.spawn` 以 route 为 identity domain，route
registry 与 opening Adapter 共同决定 created/occupied/unknown，不由 HTTP caller 直接创建 Session。

### 4.2 typed outcome

`applied / duplicate / rejected / staleAddress / retryable / ambiguous / quarantined`。
`applied` 只描述 Current oracle（processLocal）；携带 durable Receipt 的 `committed` 属于
Target-B，本步不出现。`SessionAddress` 绑定 runtime epoch，restart 后旧地址返回 `staleAddress`，
必须经 route query 重解析，不能被调用方长期缓存。

### 4.3 Executor 代际围栏与 exit 三态

executor 六类回调（received / rejected / committed / terminal / CLI-exit / worker-exit）全部经
opaque lease 进入 executor runtime，按 exact generation 判定：

- **currentExit**：durable fence 写盘且 strict readback 证明已发布 → 执行全部收敛 + 投影
  （`session.exited` dashboard 事件、lifecycle hook、startup 失败提示）。
- **retiringExit**：被替换代际的退出 → 只允许 reconcile 自己代际的 named receipt
  （`onRetiringWorkerExit`），不得触碰 replacement 的 lifecycle/projection 槽位。
- **unreadable（currentExitUnfenced）**：fence 写盘无法证明落盘 → 仍执行 exact-generation 的
  `onWorkerExit` 收敛（keyed async turn 写 durable `dispatch_unknown`；VC receipt
  dispatched→ambiguous + lease recovery arm——两个消费者都是幂等且代际门控的），但**抑制需要
  durable fence 的投影**（`session.exited` / lifecycle hook / startup 提示）。收敛与投影拆开是
  评审确认的边界：收敛缺席会让 trigger-result 永远 `running`、同 key 重试复用死会话，投影则必须
  以可证明的 fence 为前提。

stale 代际回调只留诊断，不能改写当前代际状态。

### 4.4 Per-Session lane

同一 Session 的 turn/control/executor report 进入唯一 FIFO lane，lane 内只做同步短转换（reducer
+ fence 在 `submit` 返回 Promise 前已跑完，外部 effect 是后置 `.then`）；不同 Session 完全并行。
慢 CLI 不阻塞其它会话。

### 4.5 两层 activation

| 层 | 成本 | 生命周期 |
|---|---|---|
| Session Activation | 轻量内存对象（state cache、lane、activation generation、executor handle） | 可回收、可由 store 重建 |
| Executor Activation | worker + Agent CLI/backend | 只在需要运行/观察时存在；可独立退出、reattach、cold-resume |

worker 死亡 ≠ Session 死亡；`Dormant`（record 存在、无 activation）是合法状态。

## 5. C1：普通消息一刀切换的具体改动

### 5.1 切换范围

普通 IM 消息的**全部**路径一刀切入 `submit`——新话题、已有会话 follow-up、queued/parked、
pending-repo 首启与 follower、worker replacement——无 feature flag、无新旧双路径。transport
两阶段 ACK（bounded-64 receipt）保持不变，不新增 crash-replay 宣称。

### 5.2 生产行为经注入 effect 保留（不搬进 runtime）

daemon 拥有的投递点副作用改为显式注入点（`beginTurnCardRotation`、`addReceivedReaction`、
`notifyPendingRepoStash` 等），语义与旧投递链等价：

- 流式卡按轮轮转：live 注入前 `beginNewTurn`（含按 turn 受理即创建状态卡）、worker-null refork 前
  park 旧卡并强制新卡 POST（`beginReforkTurn`）；opening 首开跳过；
- card-off 会话 ✋→✅ 受理 reaction（metadata 模块 `receivedReaction` evidence 契约）；
- dashboard SSE 的 activity / lastInputFromBot 是 process-local projection；消息预览另以白名单内的
  `lastInboundPreview` presentation evidence 持久化。二者都不拥有 lifecycle truth；
- pendingRepo 暂存提示、选仓完成后的 attention patch 清除；
- opening 话题历史 hint 双 lane（包装 prompt + codex-app sidecar）。

### 5.3 失败面显式化

ingress 终态失败（`unknown/ambiguous/quarantined/retryable/staleAddress`）向话题回一条可行动提示
（按 anchor 去重），不再静默吞消息；`rejected` 由各 policy 自身 UX 负责（如配额提示）。

### 5.4 幂等与并发正确性

三层幂等集中保证：持久 seen-message、route registry（并发 create 单赢家）、runtime 台账
（`ordinaryInputs`/`providerRecords`，有界回收：仅终态、cap 1024，在途与 retryable 不驱逐）。
重复 fork、route 并发创建、worker 替换窗口由 lane + 围栏 + 故障注入用例锁定（store 响应丢失、
并发 route-create、代际替换等窗口）。

### 5.5 净删除

- 生产已不可达的 async tail-admission 机制整体移除（daemon 函数、DaemonSession 三字段、共享
  gate 分支）；
- classify / admission gate 三份拷贝收敛为 staged 端口单一导出；
- generation reconcile 由整行深比较改为单调代际字段判定（消除一次瞬时 store 写失败后该会话本代
  内永久无法 fork 的毒化）。

## 6. 与未迁移调用方的并存边界

Dashboard close/prune/restart/suspend/cd/board/whiteboard/start/spawn/rename/lock/resume/relocate、host
maintenance、agent change、chat rename 与 async trigger fault convergence 已进入 C2 caller cut。
command/card 的 mid-session repo replacement 及 cwd/title shared provider 仍走 Current direct 写面，
以 `remaining-control-bypass=86` 独立列出；§1.3 明列的非 activation direct-call class 与其它 Target-A
缺口继续进入 `remaining-bypass=824`。这两个 remainder 都不是零，也不因 Dashboard production
binding 存在而自动迁移。

并存期间的 owner binding、route admission 与 control barrier 让被竞争的在途轮以
`stateChanged/ambiguous/quarantined` 收场并给出用户提示。新 ingress、Dashboard caller 与 executor
runtime 无任何 `cliId` policy 分支；Riff prepare→commit、tmux/zmx 持久 pane、adopt bridge 的后端
协议保留在各自 Adapter 内。共享 syntactic provider 只有抽成 Current 专用 publisher 后才可从
remainder 移入 migrated bucket。

## 7. 验证策略

| 层 | 手段 |
|---|---|
| 构建期 | `pnpm build` 内两个审计 gate（census 比对 + coverage digest/forbidden-calls），漂移即失败 |
| store contract | 同一套用例跑 CurrentSessionStore 与 in-memory fault Adapter（响应丢失、conflict、corrupt 各窗口） |
| 行为/回归 | ingress/runtime/executor/pending-repo + Dashboard control/route/reopen/scheduler 定向套件；exit 三态（含 unfenced 收敛 + async-pending / VC-receipt 两条回归）；`/t` 话题初始化与 nothing-to-send 结算以上游自带测试为 oracle |
| 故障注入 | duplicate event、两个 route-create 并发、worker replacement、reopen scratch/token stale、response-loss、跨 Session 并行不阻塞、fence 写盘失败 |
| 变异测试 | 审计 oracle：篡改源码写点、C2 exact selector、route identity、forbidden capability、shared admission 或 Runtime/A4/transport binding 后 gate 必须报警 |

## 8. 后续步骤接口

第二步的 C2/C3/C4/A4/I1 ROI gates 已完成；Target-A roll-up 仍须逐项消化
`remaining-control-bypass` 与 `remaining-bypass`，不能把 Stage2 caller cut 表述为“所有 mutation 已经
只穿 Runtime”。后续 deepening 应先从可独立归属的 command/card/shared provider seam 抽接口，再以
exact authority selector 迁移；禁止重新引入 whole-file bucket。

第三步（Target-B）在同一 Interface 后用 per-bot SQLite 替换 production Adapter：短事务提交
accepted turn / mailbox / effect receipt，commit 后才对需要 durable admission 的 ingress ACK。
当前 daemon/Dashboard process-epoch receipt 只提供本 epoch replay 与 response-loss quarantine，不冒充
crash-durable。Target-B 完成后调用方与行为合同保持不动，`current-*` 绑定层才可整体删除。
