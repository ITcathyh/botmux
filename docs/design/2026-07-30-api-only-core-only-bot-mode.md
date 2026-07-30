# PR D · API-only (core-only / headless) bot mode — 设计方案

## 目标
让 botmux 作为 **core-only 控制 Server**：riff 在 Sandbox 里纯 HTTP API 驱动 botmux → botmux 直接控 CLI Agent，**全程无需真实飞书 Bot 凭证**。

## 架构现状（已核实）
- **一个 daemon 进程 = 一个 bot**。pm2 ecosystem 有 botmux-0..3（`BOTMUX_BOT_INDEX` 经 `loadBotConfigAtIndex` 选 config）+ botmux-dashboard。
- dashboard（:3000，内网 IP 可达）代理 `/api/trigger` + `/api/sessions/:id/trigger-result` 到 per-bot daemon（`registry.getByAppId(larkAppId)`）。riff 用 dashboard `activeToken` 鉴权。
- **核心控制回路（trigger→spawn→CLI→trigger-result）走 `asyncReturnSessionId` 时已完全 Feishu-free**：虚拟 chatId `http_async_*`，`deliverFinalOutput` 命中 async 分支（worker-pool.ts:4149）后 `recordCompleted` 并 **early return，飞书投递代码全在其后不触达**。auto-worktree 的 notify 也 gated 在 `!isHttpVirtualSession`（trigger-session.ts:618）。

## 需要 gate 的耦合点（全部在 boot 层）
| # | file:line | 作用 | 处理 |
|---|-----------|------|------|
| 1 | bot-registry.ts:1874 | `larkAppSecret` 必填 throw | apiOnly 时豁免（允许缺省/占位） |
| 2 | daemon.ts:17878 `probeBotOpenId` | 调 `/bot/v3/info` 探 open_id | apiOnly 时跳过（已 `.catch` 非致命，但省掉无谓请求） |
| 3 | daemon.ts:17949 `startLarkEventDispatcher` | 建 + start WSClient 长连接 | apiOnly 时跳过（核心：不订阅飞书事件） |
| 4 | daemon.ts:17907 `checkRequiredScopes` | 校验飞书权限 scope | apiOnly 时跳过（已 `.catch` 非致命） |

运行时（per-turn）：`larkAppSecret` 作为 env 传给 worker（worker-pool.ts:2303 等），仅 worker.ts:4442 图片上传用到，**已优雅降级**（`lark credentials missing` skip）。无需额外改。

## 设计

### 1. 配置：`apiOnly?: boolean`（BotConfig）
按仓库现有 idiom（`disableCliBypass` / `codexRpcInput`）：
- `bot-registry.ts` BotConfig 接口加 `apiOnly?: boolean`（line ~914 附近）
- 解析：`apiOnly: entry.apiOnly === true`（line ~2108 附近）
- **合成身份**：apiOnly bot 的 `larkAppId` 用 `local_<slug>` 形式（非 `cli_` 前缀）。`larkAppSecret` 允许缺省——解析时若 apiOnly 且缺 secret，填空串占位（下游 env 传空、上传自然 skip）。

### 2. 校验豁免（bot-registry.ts:1874）
```
if (!entry.larkAppSecret || typeof entry.larkAppSecret !== 'string') {
  if (entry.apiOnly !== true) {
    throw new Error(`Bot config [${i}]: larkAppSecret is required and must be a string`);
  }
  // apiOnly: secret 可缺省，占位空串
}
```
`larkAppId` 仍必填（作为合成身份 + cachedLarkAppId gate + registry key）。

### 3. boot 跳过（daemon.ts，per-bot init 块 ~17860–17950）
在 probe/scope-check/startLarkEventDispatcher 外层加 `if (!cfg.apiOnly)`：
- `probeBotOpenId` + `writeBotInfoFile` 链（17878）→ apiOnly 跳过；`botOpenId` 用合成值（如 `bot_local_<slug>`）直接 set，避免下游读 undefined。
- `checkRequiredScopes`（17907）→ apiOnly 跳过。
- `startLarkEventDispatcher`（17949）→ apiOnly 跳过（**不建 WSClient**）。仍保留 `botHandlers.set` 以防其它路径读取（评估）。
- `setLarkAppId(cfg.larkAppId)`（17684）**保留**——合成 id 满足 `/api/trigger` 的 cachedLarkAppId gate。
- `writeDaemonDescriptor` **保留**——dashboard `getByAppId(合成id)` 靠它路由。

### 4. autoStartOnGroupJoin / VC / doc-comment 等飞书专属功能
apiOnly bot 天然不订阅事件 → 这些入口永不触发，无需额外禁用（评估确认无主动轮询飞书的路径）。

## 影响面（CLAUDE.md 要求）
- **跨平台**：改动纯 TS 逻辑分支，Linux（daemon 实跑）/macOS 一致。
- **跨 CLI**：apiOnly 与 cliId 正交；20+ adapter 经 worker spawn，spawn 不依赖真 `larkAppSecret` 运行时值（仅上传用、已降级）。canary 用 codex-app 验，另需在**一个非 codex** CLI 上确认 spawn 正常。
- **跨后端**：PTY / tmux 均不受影响（apiOnly 只改 boot 的飞书订阅，不碰 backend）。
- **零回归红线**：普通飞书 bot（`apiOnly` 缺省/false）boot 路径**字节级不变**——所有跳过都在 `if (!cfg.apiOnly)` 内，默认分支＝原逻辑。现网 4 bot 照跑。

## 测试
1. 单测：apiOnly bot 注册（缺 secret 不 throw）；普通 bot 缺 secret 仍 throw（护栏）。
2. 单测/集成：apiOnly daemon boot 不调 startLarkEventDispatcher（source-lock 或 mock 断言）。
3. 集成：`asyncReturnSessionId` trigger → trigger-result completed，全程无飞书调用（复用现有 http_async fixture）。
4. 回归：普通 bot boot 仍 probe + WSClient（断言默认分支不变）。
5. `pnpm build` + `pnpm test` 绿。

## 部署
rebase master → 开 PR（中文 + 影响面）→ 发 canary → 配一个 `apiOnly:true` + `cliId:codex-app` 的 bot（合成 larkAppId）→ 把 baseUrl + 合成 botId 进群、dashboard token 私密给 riff。
