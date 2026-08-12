# CLI 命令

在终端里管理 daemon 和会话。

| 命令 | 说明 |
|------|------|
| `botmux setup` | 交互式配置（首次 / 添加 / 编辑 / 删除机器人） |
| `botmux start` | 启动 daemon（PM2 管理） |
| `botmux stop` | 停止 daemon |
| `botmux restart [--include-pm2]` | 重启 daemon（自动恢复活跃会话）；`--include-pm2` 会同时重启 botmux 专用 PM2 God daemon |
| `botmux logs [--lines N]` | 查看日志 |
| `botmux status` | 查看 daemon 状态 |
| `botmux upgrade` | 升级到最新版本 |
| `botmux list` (别名 `ls`) | 交互式列出活跃会话；选中受管 tmux / ZMX 会话后按 Enter 可 attach（脚本使用 `--plain`） |
| `botmux delete <id>` (别名 `del`/`rm`) | 关闭指定会话，支持 ID 前缀匹配 |
| `botmux delete all` | 关闭所有活跃会话 |
| `botmux delete stopped` | 清理进程已退出的僵尸会话 |
| `botmux dashboard [current\|rotate]` | 获取当前 Dashboard 登录 URL，尚无 token 时创建第一个；`rotate` 才显式替换已有 token |

daemon 在线时，`botmux delete` 会先请求会话所属 daemon 执行与 `/close`
一致的生命周期收口：移除内存中的活跃会话、持久化关闭状态，并回收
worker、后端与订阅。仅当所属 daemon 确认不在线时才使用本地收口；在线
daemon 拒绝或 IPC 连接失败时命令返回失败，不会继续本地强杀。

## 开机自启

```bash
botmux autostart enable   # 注册（macOS / Linux / Windows，无需 sudo）
botmux autostart disable  # 注销
botmux autostart status   # 查看状态
```

- **macOS**：`enable` 只写 `~/Library/LaunchAgents/com.botmux.daemon.plist`，不会重新加载或 bootstrap 这个 `RunAtLoad` 任务；下次登录时生效。
- **Linux**：写 `~/.config/systemd/user/botmux.service`，只运行 `systemctl --user enable`（不带 `--now`）；在用户服务管理器下次启动时生效，通常为下次登录（启用 linger 时为开机后）。
  - 服务器/无桌面环境登出会停服务，需跨登出常驻请 `sudo loginctl enable-linger <用户名>`。
- **Windows**：注册当前用户登录时触发的 Task Scheduler 任务；若任务注册失败，则回退到当前用户的 Startup 文件夹。
- 单元文件里的 `node`/`cli.js` 路径来自当前 `process.execPath`，nvm/fnm 切版本后跑一次 `enable` 重写即可（`start`/`restart` 也会自动检测路径变化并重写下次登录使用的文件）。
- `enable`/`disable` **只注册或注销自启钩子，不启动、停止或重启当前 PM2 daemon**；当前进程仍由 `botmux start` / `botmux stop` 管理。

## 会话内子命令（给 CLI agent 用）

session 信息通过祖先进程标记自动推断，agent 直接调：

| 命令 | 说明 |
|------|------|
| `botmux send [content]` | 向当前话题发消息（stdin / heredoc / `--content-file`；`--images`/`--files`/`--videos`/`--card-file`/`--card-json`/`--mention`） |
| `botmux bots list` | 列出当前群里的机器人（含 open_id） |
| `botmux history [--limit N]` | 拉会话历史（JSON） |
| `botmux quoted <message_id>` | 拉被引用的单条消息（JSON） |
| `botmux schedule add/list/remove/pause/resume/run` | 管理定时任务 |
