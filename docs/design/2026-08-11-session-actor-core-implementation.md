# Session Actor Core 实施设计（第一步：A0→A3 + C1）

> 本文是 Session Actor 演进提案的**实施摘要**：只保留与已落地代码直接对应的设计决策与改动内容，
> 供 reviewer 与后续步骤（C2/C4/A4、Target-B）的实施者对照代码阅读。
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
| 第二步 | C2 Dashboard 命令、C4 scheduler producer、C3 projection/readiness、A4 activation/restore 生命周期按各自 ROI gate 迁入同一入口 | C3 ✅；其余后续 |
| 第三步 | per-bot SQLite durable store 离线演练与单向 cutover（Target-B），届时才把 ACK 升级为崩溃可恢复的 durable 承诺 | 后续 |

本步明确**不做**：不改变 durability 承诺（所有 outcome 标注 `processLocal`）、不引入 SQLite、
不迁移 C2/C4 调用方、不分配独立 BotId（I1）。

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
| IM 侧生产注入 | `src/im/lark/current-ordinary-ingress-daemon.ts`、`current-ordinary-ingress-production.ts` | Lark 物化上下文、daemon 拥有的副作用注入点（卡片轮转、受理 reaction、失败提示等） |

### 3.3 A0 census 与构建期审计 gate

- `docs/architecture/session-authority-inventory.json`：源码 AST 推导的全量 Session/DaemonSession
  写点台账，每个写点分类为 `session_owned_persisted` / path-specific authority / `ephemeral_runtime`
  / `projection`，并记录 authority owner 与 access lane。`pnpm audit:session-state` 在构建期重新
  推导比对，未分类或漂移即失败（`--update` 后需人工分类）。
- `docs/architecture/session-runtime-coverage.json`：Target-A 可执行覆盖台账。按 coverage 条目
  钉住已迁移边界的写点 digest 与 production binding（含 forbidden-calls 扫描），`remaining-bypass`
  条目如实列出尚未归入具体 milestone 的 Target-A shared/direct-writer remainder（本 baseline 为
  674 条记录 / 677 个 mutation）；C2/C3/C4/A4 各自另有独立 bucket，不能与它重复计数。
  `pnpm audit:session-runtime` 构建期校验。
- 两份台账均有变异测试防腐化（oracle 测试篡改源码后断言审计必须报警）。

## 4. 执行语义

### 4.1 命令四类与 replay policy

`submit` 不把命令扁平化为 generic union；四类命令各有独立 policy kernel：

| Policy | 适用对象 | crash/retry 行为 |
|---|---|---|
| `replayable` | 尚未越过外部 effect barrier 的 ingress | 同 idempotency key 重投返回同一 logical result |
| `reconcile-first` | CLI input、卡片 create/update 等可能已生效的 effect | 先按 stable identity reconcile；未知进 `ambiguous`，不盲重放 |
| `at-most-once-dispatch` | keyed `/api/trigger`（已提交 `reserved→attempting` barrier） | `attempting` 后 crash 收敛为 `dispatch_unknown`，永久禁止普通 redispatch |
| `terminal` | 已有 terminal receipt 的命令 | retry 只读回 receipt |

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

Dashboard close/cancel/activate/rename、scheduler、卡片 mid-session 换仓仍走 Current 写面，
coverage 台账 `remaining-bypass` 如实列出。并存期间的绑定校验让被竞争的在途轮以
`stateChanged/quarantined` 收场并给出用户提示。新 ingress 与 executor runtime 无任何 `cliId`
分支；Riff prepare→commit、tmux/zmx 持久 pane、adopt bridge 的后端协议保留在各自 Adapter 内。

## 7. 验证策略

| 层 | 手段 |
|---|---|
| 构建期 | `pnpm build` 内两个审计 gate（census 比对 + coverage digest/forbidden-calls），漂移即失败 |
| store contract | 同一套用例跑 CurrentSessionStore 与 in-memory fault Adapter（响应丢失、conflict、corrupt 各窗口） |
| 行为/回归 | ingress/runtime/executor/pending-repo 定向套件；exit 三态（含 unfenced 收敛 + async-pending / VC-receipt 两条回归）；`/t` 话题初始化与 nothing-to-send 结算以上游自带测试为 oracle |
| 故障注入 | duplicate event、两个 route-create 并发、worker replacement、跨 Session 并行不阻塞、fence 写盘失败 |
| 变异测试 | 审计 oracle：篡改源码写点后断言 gate 必须报警 |

## 8. 后续步骤接口

第二步余项把 C2（Dashboard 命令）、C4（scheduler 只算 due/run ID 后 `submit`）、A4
（singleflight activation、reattach/cold-resume/quarantine）迁入同一入口；C3 已提供可重建
projection 与 `online/restoring/ready` Current runtime capability，I1 再把 owner binding 提升为不可变
BotId。第三步（Target-B）在同一 Interface 后用
per-bot SQLite 替换 production Adapter：短事务提交 accepted turn / mailbox / effect receipt，
commit 后才对需要 durable admission 的 ingress ACK。届时调用方与全部行为测试不动，`current-*`
绑定层整体删除。
