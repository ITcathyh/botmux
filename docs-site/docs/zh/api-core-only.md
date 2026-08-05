# Core-only（apiOnly）API 控制

> 把 botmux 当作一个**受控的 HTTP 服务嵌入**你自己的系统：一个进程、固定端口、绑定 `127.0.0.1`、**不需要任何飞书凭证 / bots.json / pm2 / dashboard**。你的编排器（任务 runner、CI、后端服务、沙箱）通过 HTTP 驱动它跑 CLI（codex / claude-code 等）、轮询结果、按需拿到可写 Web 终端。

本文面向**把 botmux 嵌入自己产品**的集成方（例如在沙箱里内嵌一个 botmux 跑 codex）。如果你只是想让外部系统触发一个**已在飞书群里运行的普通机器人**，请看 [API 编程式触发任务](/api-task-trigger)——那篇讲的是触发/轮询/取消的四态契约，本文与之互补：**同一套 trigger/poll 契约在 core-only 下同样适用**，本文只讲 core-only 特有的启动、鉴权、路由分界、可写终端与安全边界。

---

## 1. core-only 与普通 fleet 的区别

| | 普通 `botmux start`（fleet） | `botmux serve --api-only`（core-only） |
|---|---|---|
| 进程模型 | pm2 + dashboard + 每个 bot 一个 daemon | **单进程**，前台运行，进程存活即服务存活 |
| 飞书凭证 | 需要 `larkAppSecret`，缺则启动失败 | **完全不需要**，也不构造飞书 Client |
| 配置来源 | `~/.botmux/bots.json` / `BOTS_CONFIG` | **忽略一切外部配置**，合成一个 apiOnly bot |
| 出站通道 | 回复发到飞书话题群 | **无飞书出站**（no-transport），结果只经 HTTP 取回 |
| 绑定 | dashboard/IPC 端口按需探测 | 固定端口、`127.0.0.1`、bind-or-fail |
| 状态目录 | `~/.botmux/data` | 专用 `~/.botmux/core-only/<botId>/data`（隔离） |

核心一句话：**core-only 是一个 headless、单租户、纯 loopback 的 botmux**。它保留完整的 daemon IPC 契约，但去掉了飞书这一侧。

---

## 2. 启动

两种等价启动方式：

```bash
# 方式一：CLI 子命令（推荐，前台运行，stdio 继承，便于 launcher 盯 ready line）
BOTMUX_API_PORT=8930 botmux serve --api-only

# 方式二：直接跑入口（等价，供嵌入式 spawn）
BOTMUX_CORE_ONLY=1 BOTMUX_API_PORT=8930 node <pkg>/dist/index-core-only.js
```

可选环境变量 / 参数（`--flag` 优先于环境变量）：

| 参数 | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| `--port` | `BOTMUX_API_PORT` | （必填） | 固定监听端口，bind-or-fail |
| `--bot` | `BOTMUX_API_ONLY_BOT` | `local_riff` | 合成 bot 的 id，必须形如 `local_<slug>` |
| `--cli` | `BOTMUX_CORE_CLI` | `codex-app` | 跑哪个 CLI（`codex` / `claude-code` / …） |
| `--working-dir` | `BOTMUX_CORE_WORKING_DIR` | 当前目录 | CLI 工作目录 |
| `--state-dir` | `BOTMUX_CORE_STATE_DIR` | `~/.botmux/core-only/<botId>/data` | 专用状态根 |

> **可视 TUI vs 结构化返回**：`--cli codex-app` 走 app-server runner，结构化返回、无可视终端；`--cli codex`（或 `claude-code`）在 tmux pane 里跑可视 TUI，可经 Web 终端围观/操作（见 [§6](#6-可写-web-终端)）。

### 就绪契约

daemon **先 bind 端口、后完成 durable restore**。所以「端口能连」不等于「可以触发」——必须等就绪：

- **stdout ready line**（锁定契约，正则 `^\[core-only\] listening on `）：
  ```
  [core-only] listening on 127.0.0.1:8930 (bot local_riff, cli codex-app)
  ```
  这一行**只在 restore 完成后**才打印。
- **`GET /healthz`**（公共，免鉴权）：
  - 未就绪 → `503 {"ok":false,"status":"starting"}`
  - 就绪 → `200 {"ok":true}`

就绪屏障同时作用于**公共控制路由**：restore 未完成时，`/api/trigger`、`/api/sessions/:id/trigger-result`、`/api/sessions/:id/insight` 也返回 `503 {status:'starting'}`——所以即使你的客户端跳过 `/healthz` 探针，也不会触发进一条正在竞态恢复的路径。**推荐 launcher 先轮询 `/healthz` 到 200 再发第一条 trigger。**

---

## 3. 路由分界：公共 vs 需签名

core-only 里 **trusted-host HMAC 始终开着**。只有一个**紧致的 allowlist** 绕过 HMAC，其余每条 IPC 路由都仍需签名。这是刻意的安全设计：早期「全部路由免鉴权」会让一个同机 co-resident 的模型 turn 读写会话/调度/发起变更。

**公共（免 HMAC）**——就这四条：

| 路由 | 方法 | 用途 |
|---|---|---|
| `/healthz` | GET | 就绪探针（无数据、无副作用） |
| `/api/trigger` | POST | 发起一轮任务 |
| `/api/sessions/:id/trigger-result` | GET | 轮询最终结果（四态） |
| `/api/sessions/:id/insight` | GET | 轮询对话/进度 |

> `/api/asks/answer` **刻意不在** allowlist：它以 askId 为键、无会话绑定，暴露会让任意同机 turn 劫持别的待答 ask。

**其余全部路由需要 HMAC**——包括你要的可写终端 `GET /api/sessions/:id/write-link`、`GET /api/sessions/:id`（会话元信息）、`POST /api/sessions/:id/close`（取消）等。下一节讲怎么正确签名。

---

## 4. HMAC 签名（**最容易踩的坑：bind**）

需签名路由用 loopback HMAC。请求带三个 header：

| Header | 值 |
|---|---|
| `X-Botmux-Cli-Ts` | Unix **秒**时间戳（字符串），验证窗口 ±30s |
| `X-Botmux-Cli-Nonce` | 随机 hex（60s 内不重放） |
| `X-Botmux-Cli-Auth` | `HMAC_SHA256(secret, msg)` 的 **base64url** |

密钥是 `~/.botmux/.dashboard-secret` 里的**原始 43 字符 base64url 字符串**——**直接当 HMAC key 用，不要再 base64 解码成 bytes**。

### ⚠️ 关键：`msg` 必须带 bind

core-only 对**非公共路由**在 server 层先走一道**带 bind** 的校验，通过后才进 route 处理器。bind 把签名绑定到「方法 + 路径 + 端口」，防止一个签名被重放到别的路由/端口。

```
bind = `${METHOD} ${pathname} ${port}`     // 例: "GET /api/sessions/<sid>/write-link 8930"
msg  = `${ts}:${nonce}:${bind}`
```

三个易错点：

1. **`port` 是服务实际 bound 的端口**（如 `8930`），**不是** Host 头里的值——verifier 用它自己 bind 的端口重建 bind。
2. **`pathname` 不含 query string**（用 `URL().pathname`）。
3. **`secret` 用原始字符串**当 key，别解码。

> 症状对照：如果你只签了 bare `ts:nonce`（漏了 bind），会得到 **HTTP 401 `{reason:"sig_mismatch"}`**。因为公共路由（trigger-result 等）压根不验签，这个 bind 问题往往**第一次在 write-link 上才暴露**——很容易误判成 secret/时窗错。

### 参考实现

仓库内 `src/core/daemon-ipc-auth.ts` 的 `daemonIpcAuthHeaders()` 就是权威实现，直接照搬其逻辑：

```js
import { createHmac, randomBytes } from 'node:crypto';

function coreOnlyAuthHeaders(secret, method, path, port) {
  const pathname = new URL(path, `http://127.0.0.1:${port}`).pathname; // 去掉 query
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = randomBytes(8).toString('hex');
  const bind = `${method.toUpperCase()} ${pathname} ${port}`;
  const sig = createHmac('sha256', secret)          // secret = 原始 base64url 字符串
    .update(`${ts}:${nonce}:${bind}`)
    .digest('base64url');
  return {
    'X-Botmux-Cli-Ts': ts,
    'X-Botmux-Cli-Nonce': nonce,
    'X-Botmux-Cli-Auth': sig,
  };
}
```

---

## 5. 触发与轮询

触发/轮询/取消的**四态契约与普通 bot 完全一致**，详见 [API 编程式触发任务](/api-task-trigger)。core-only 下的差异只有：

- **必须用 HTTP 应答模式**：apiOnly bot 的 trigger 请求必须带 `options.waitForFinalOutput`（同步）或 `options.asyncReturnSessionId`（异步），否则 `400 bad_request`（apiOnly 没有飞书群可回复，必须走 HTTP 拿结果）。
- 异步触发返回一个合成 `http_async_*` chatId + 真实 `sessionId`；用该 `sessionId` 轮询 `trigger-result`。
- 用户指令放在**顶层 `instruction`** 字段（渲染成 trusted `<botmux_task>`）——不是 `prompt`。
- `options.model` / `options.reasoningEffort` 对 codex 家族的 fresh trigger 生效。
- **轮询 `trigger-result` 用完整 sessionId**（UUID），不要用日志里的 `[worker:xxxxxxxx]` 短 tag——短 tag ≠ sessionId，会 `session_not_found`。

```bash
# 触发（异步）——公共路由，无需签名
curl -s http://127.0.0.1:8930/api/trigger -X POST -H 'content-type: application/json' -d '{
  "source": {"type": "custom"},
  "target": {"kind": "turn", "botId": "local_riff"},
  "envelope": {"format": "text", "sourceName": "my-runner", "trusted": false},
  "instruction": "跑一下测试并报告结果",
  "options": {"asyncReturnSessionId": true}
}'
# → {"ok":true, "async":{"sessionId":"<uuid>", ...}}

# 轮询——公共路由，无需签名，用完整 sessionId
curl -s "http://127.0.0.1:8930/api/sessions/<uuid>/trigger-result"
# → running / completed / failed / not_found（四态见 api-task-trigger）
```

> **completion 机制**：trigger-result 翻 `completed` 依赖 botmux 从 CLI transcript 里抽取 final_output。core-only claude-code 曾有一个「首轮 ready-gate 超时回落后落盘 user 行截头 → 完成信号接不上 → 永久 running」的 bug，已在 **v3.9.0-canary.15** 修复（改用后缀锚定的内容证明绑定 durable mark）。用该版本及以上。

---

## 6. 可写 Web 终端

core-only（tmux backend + 可视 CLI）可以对外提供一个**可操作**的 Web 终端。取链接走 `GET /api/sessions/:id/write-link`（**需 HMAC 签名，见 §4**）：

```bash
# 注意：write-link 是需签名路由，headers 必须带 §4 的 bind 签名
curl -s "http://127.0.0.1:8930/api/sessions/<sid>/write-link" \
  -H "X-Botmux-Cli-Ts: ..." -H "X-Botmux-Cli-Nonce: ..." -H "X-Botmux-Cli-Auth: ..."
# → {"ok":true, "url":"http://127.0.0.1:<proxyPort>/s/<sid>?token=<写token>"}
```

- 返回的 URL 带**写 token**，打开即得可输入的 xterm（`readonly=false`）。
- 只读版：`readableTerminalUrlFor` / 卡片里的只读链接带的是 `viewToken`（只能看不能写）。
- backend 为 `zmx` 时不支持 Web 终端（`409 terminal_unsupported`）；tmux/pty 支持。

### ⚠️ 不要缓存 URL——现签现取

**写 token 和端口不是稳定的**：它们由 worker 每一代 `randomBytes(32)` 新铸，worker 一旦换代（suspend 后唤醒 / CLI 崩溃重启 / daemon 重启）旧 token 即失效、端口也可能变。

- ✅ 正确姿势：前端每次「打开终端」时**现调 write-link 拿当次 URL，用完即弃**，只持久化**稳定的 sessionId**。
- ❌ 错误姿势：把 write-link URL 存进任务记录/数据库——换代后会**静默失效**（进去连不上，但没有明显报错）。

> 单个 core-only 会话**不会被空闲回收**（live-worker cap 默认 30、且**无 idle 超时**，单租户 1 个会话永远 ≤ cap），所以正常情况下 worker 常驻、token 稳定；但崩溃/daemon 重启仍会换代，现签现取能自动拿到新 token。

---

## 7. 安全边界（no-transport）

core-only 是「无飞书出站通道 + 单租户 loopback」，围绕这点有一圈刻意的加固，集成时应知晓：

- **无飞书 Client**：apiOnly bot 根本不构造 `Lark.Client`，`larkAppSecret` 对 worker **withheld**（不注入子进程环境）。
- **配置权威**：忽略 `~/.botmux/bots.json` 与 `BOTS_CONFIG`，且入口**删除** `process.env.BOTS_CONFIG`——避免 fork 出的 worker 里 agent `cat $BOTS_CONFIG` 读到真实 fleet 的 sibling 凭证。
- **状态隔离**：入口**冻结** `SESSION_DATA_DIR` 到专用 `~/.botmux/core-only/<botId>/data`——一个把 host 的 `SESSION_DATA_DIR` 带进来的 managed turn 无法让 core-only 去读真实 fleet 的会话/pid/descriptor。
- **loopback 冻结**：`BOTMUX_WORKER_HTTP_HOST` 与 `WEB_EXTERNAL_HOST` 都被冻结成 `127.0.0.1`（bind 与广告 host 一致），worker web server 不会暴露在所有网卡上。
- **跳过 host 维护**：core-only 不跑 fleet 级的 auto-restart / `botmux restart` / 共享 HOME breadcrumb 写入，绝不触碰同机的全局 botmux 安装。
- **HMAC 仍是硬门**：loopback 只是连通性不是身份——同机（含 bwrap 沙箱，默认共享网络命名空间）的进程也能拨 `127.0.0.1`，所以除 §3 那四条公共路由外，一切仍需 HMAC。

---

## 附：core-only 端点速查

| 端点 | 方法 | 鉴权 | 用途 |
|---|---|---|---|
| `/healthz` | GET | 公共 | 就绪探针（503 starting / 200 ok） |
| `/api/trigger` | POST | 公共 | 发起一轮任务（须带 HTTP 应答模式） |
| `/api/sessions/:id/trigger-result` | GET | 公共 | 轮询最终结果（四态） |
| `/api/sessions/:id/insight` | GET | 公共 | 轮询对话/进度 |
| `/api/sessions/:id/write-link` | GET | **HMAC + bind** | 取可写终端 URL（现签现取） |
| `/api/sessions/:id` | GET | **HMAC + bind** | 会话元信息 |
| `/api/sessions/:id/close` | POST | **HMAC + bind** | 取消/关闭会话 |

- 触发请求体结构、`errorCode`、四态语义、重启存活保证：见 [API 编程式触发任务](/api-task-trigger)。
- 参考签名实现：`src/core/daemon-ipc-auth.ts`（`daemonIpcAuthHeaders`）。
