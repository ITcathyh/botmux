# 路线二可行性勘察：sandbox 内嵌 headless botmux 驱动 CLI

> 目标（申晗定）：**不依赖 bot 注册，headless 启动一个精简 botmux，在 sandbox 内驱动 CLI 一轮**。本文是代码层面的可行性 + 形态判断，不是乐观估计。两路勘察结论如下。

## 结论速览

| 维度 | 判定 | 一句话 |
|------|------|--------|
| Registration-free 启动 | **中等手术（边界清晰）** | 现在用一个假的单条 bots.json 就能 headless 跑起 CLI 驱动核；真·零注册只需改 6 个浅耦合点 |
| PTY 核 ÷ 飞书/dashboard/多 bot | **切得干净** | 飞书投递从来不在 worker.ts 里，早已隔在 `process.send` IPC 墙的另一侧（daemon 端） |
| PTY 核精简到"单 CLI 单后端" | **中等手术** | 难点不是飞书，是 worker.ts 里 10 CLI × 6 后端 × adopt 模式交织在共享函数里 |
| codex 归属 | **仍走独立 runner** | 结构化 codex 不进这个 PTY daemon，v1 那个 runner 保留，两者并存 |

## 1. Registration-free 启动：中等手术，边界清晰

核心事实：**CLI 驱动核（fork→spawn→抓输出）不发任何阻塞性 Lark 网络调用。** 每个硬依赖要么是按 larkAppId 的 config 加载/map 查找，要么是飞书投递（send/upload，fire-and-forget、失败非致命）。

- daemon **不能完全无 bots.json 启动**（3 处硬 throw：config 文件缺失 / 空数组 / 条目缺 larkAppId+larkAppSecret）。但**一条假的单 bot 条目**（larkAppId+larkAppSecret 填任意字符串）就能让 `startDaemon` 跑到底——不连飞书、WS 连不上只是后台记错、不阻塞启动。
- spawn 一轮 CLI 的硬需求只有：`larkAppId`（作**标识**：map key + 环境变量 + session 存储 scope，纯本地无网络）、`cliId`/`workingDir`/`model`。`larkAppSecret` 只在截图上传 + `botmux send` 用（缺了非致命早退）；`botName`/`botOpenId` 纯装饰。
- **输出抓取完全独立于 Lark**：worker 读 CLI 自己的 JSONL/rollout 文件、emit `final_output` IPC；投递到飞书是 daemon 端后续的事。
- 已有先例：`BOTMUX_WORKFLOW=1` worker 分支（跳过 chat 侧飞书特性）、`botmux goal run`（daemon-free 入口，靠 manifest 文件判成功、不解析飞书回复）。

**真·零注册（连假 bots.json 都不要）要改的 6 个点**都是浅的：config 加载守卫（bot-registry 3 处）+ `getBot(larkAppId)` map 查找（worker-pool forkWorker / trigger-session）。改法：允许一个"内联 profile"替代 bots.json 查找。

## 2. PTY 核 ÷ 飞书：已经是干净的进程 + IPC 墙

**worker.ts 不 import 任何 Lark SDK / card-builder / dashboard / daemon 单体。** 它跟 daemon 的全部上行只有两个函数：`send(msg: WorkerToDaemon)` / `sendAndFlush` → `process.send()`。飞书渲染/投递全在墙的另一侧（`worker-pool.ts`，跑在 daemon 里）。worker 自己的注释："daemon owns the card"。

- 抓取侧（worker，无 Lark）：`drainTranscript` 读 JSONL → 指纹归因 → `send({type:'final_output',...})`，终点就是一条 IPC。
- 投递侧（daemon，全 Lark）：`worker-pool.ts` 收 `final_output` → `buildContextualReplyCard` → 发 Lark。
- **抓输出 和 发飞书不是同一条代码路径**，是两个进程里两个文件、由一条 `final_output` 消息连接。要 headless，**换掉那 ~5 个 IPC emitter 的 sink**（final_output / user_notify / screen_update / tui_prompt / turn_terminal）成本地 sink 即可，抓取逻辑一行不动。
- IdleDetector（只吃 CliAdapter 的 completionPattern/readyPattern）、ScreenAnalyzer（吃 config+callbacks）、pty-backend、claude-transcript、bridge-turn-queue（"Pure, no fs/IPC"）——都自包含、无 daemon/bot 触达，是最干净的可搬运件。

## 3. PTY 核精简：难点是多 CLI × 多后端 × adopt，不是飞书

worker.ts ~1 万行是**模块级全局单例**（一个进程一个 session，靠 `process.on('message')` 驱动），且内部把 **10 个 CLI、~6 个后端、adopt 现有 pane 模式**交织在共享函数里：
- 34 处 `cliId === 'x'` 分支（10 个 CLI）+ 14 个 CLI 专属 transcript 服务 import。
- 54 处 `backendType` 引用（tmux/zellij/herdr/riff/observe/pipe）。
- 47 处 `adoptMode`（收编人类现有 pane 的路径，跟"我们自己 spawn"的路径交织）。

**估算**：跑 claude-code headless（PTY+抓取、无飞书）约 **55–65% 的 worker.ts 是必需/可复用**，35–45% 可剥离，但剥离部分部分**嵌在共享函数里**（是改分支、不是删文件）。大块可剥离：web 终端 HTTP/WS server（~1090 行）、截图→飞书上传（~450 行）、9 个非 claude 的 transcript bridge（散在各处）、5 个非 PTY 后端。

**两种精简策略**：
- **A·薄**（推荐先做）：不拆 worker 单例，headless 核**通过同一套 init/message IPC 驱动它**，只把 daemon 侧的 IPC sink 换成本地（不发飞书、写本地结果）。多 CLI/多后端/adopt 的分支留着不管（用不到就不触发）。**改动最小、最快到端到端**。
- **B·彻底**：把 worker 全局态重构成实例、剥掉 9 个 CLI + 5 个后端 + adopt。**大手术**，收益是真"单 CLI 单后端"精简体积。第一版不必做。

## 4. codex 归属（回 riff Q4）

codex（结构化）**仍走 v1 那个独立 riff-codex-runner**，不并入这个 PTY daemon。理由：codex-app 是 app-server JSON-RPC 协议、本就不需要 PTY/屏幕分析/transcript 那套 worker 栈；塞进 PTY daemon 是倒退。所以 sandbox 内最终形态是**并存**：
- 结构化类 CLI（codex，将来 traex）→ 轻量 runner（已就绪）。
- PTY 类 CLI（claude-code/gemini/cursor）→ 这个精简 headless daemon。
riff 侧可以用**同一个 stdio/IPC 协议**面对两者（run/status/output/completed/awaiting_input），底层 botmux 内部分派到 runner 还是 daemon 对 riff 透明——这正是 riff 想要的"协议 CLI 无关"。

## 控制面草图（无 bot 的入口）

headless daemon 给 riff 的控制入口（替代现在 `/api/trigger` 带 botId）：
- 一个**本地 HTTP/IPC**（loopback，或 stdio），接：`run { cliId, cwd, prompt, model?, ... }`——**无 botId**，用内联 profile 替代 bot 注册。
- 复用现有四态/流式语义：running / output(增量) / completed(带 usage) / failed；awaiting_input 走 turn-结束式（同 v1 结论）。
- 与 v1 runner 协议**同形**，riff 侧一套 adapter 面对 runner（codex）和 daemon（PTY CLI）。

## 建议的落地顺序

1. **先薄策略（A）**：现有 daemon 加一个"内联 profile / registration-free"启动模式（改 6 个浅耦合点）+ 一个无 botId 的本地控制入口 + IPC sink 可切本地。这样最快让"sandbox 内 headless 驱动 claude-code 一轮"跑通。
2. 验通后再评估要不要走彻底精简（B）——只有当 sandbox 体积/资源真成问题时才值得那个大手术。
3. codex 保持 runner 不动，两者并存，riff 一套协议。
