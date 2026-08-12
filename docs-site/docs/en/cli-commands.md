# CLI Commands

Manage the daemon and sessions from the terminal.

| Command | Description |
|------|------|
| `botmux setup` | Interactive configuration (first run / add / edit / delete a bot) |
| `botmux start` | Start the daemon (managed by PM2) |
| `botmux stop` | Stop the daemon |
| `botmux restart [--include-pm2]` | Restart the daemon (automatically restores active sessions); `--include-pm2` also restarts botmux's PM2 God daemon |
| `botmux logs [--lines N]` | View logs |
| `botmux status` | View daemon status |
| `botmux upgrade` | Upgrade to the latest version |
| `botmux list` (alias `ls`) | Interactively list active sessions; select a managed tmux / ZMX session and press Enter to attach (use `--plain` in scripts) |
| `botmux delete <id>` (aliases `del`/`rm`) | Close the specified session, with ID prefix matching |
| `botmux delete all` | Close all active sessions |
| `botmux delete stopped` | Clean up zombie sessions whose processes have exited |
| `botmux dashboard [current\|rotate]` | Get the current Dashboard login URL, creating the first token if absent; `rotate` explicitly replaces an existing token |

When the daemon is online, `botmux delete` first asks the owning daemon to run
the same lifecycle teardown as `/close`: evict the in-memory active session,
persist the closed state, and clean up the worker, backend, and subscriptions.
The local fallback is used only when the owning daemon is confirmed offline. If
an online daemon rejects the request or IPC fails, the command fails without a
local hard kill.

## Auto-Start on Boot

```bash
botmux autostart enable   # Register (macOS / Linux / Windows, no sudo needed)
botmux autostart disable  # Unregister
botmux autostart status   # Check status
```

- **macOS**: `enable` writes `~/Library/LaunchAgents/com.botmux.daemon.plist`; it never reloads or bootstraps the `RunAtLoad` job and takes effect at the next login.
- **Linux**: writes `~/.config/systemd/user/botmux.service` and runs only `systemctl --user enable` (without `--now`); it takes effect when the user manager next starts, normally at the next login (or at boot when linger is enabled).
  - On servers / headless environments, logging out stops the service; to keep it running across logout, run `sudo loginctl enable-linger <username>`.
- **Windows**: registers a per-user Task Scheduler task that runs at login; if task registration fails, it falls back to the current user's Startup folder.
- The `node`/`cli.js` paths in the unit file come from the current `process.execPath`; after switching versions with nvm/fnm, just run `enable` once to rewrite them (`start`/`restart` also auto-detect path changes and rewrite the future-login file).
- `enable`/`disable` **only register or unregister the auto-start hook; they do not start, stop, or restart the current PM2 daemon**. Use `botmux start` / `botmux stop` to manage the current process.

## In-Session Subcommands (for the CLI agent)

Session info is inferred automatically from ancestor-process markers, so the agent can call these directly:

| Command | Description |
|------|------|
| `botmux send [content]` | Send a message to the current topic (stdin / heredoc / `--content-file`; `--images`/`--files`/`--videos`/`--card-file`/`--card-json`/`--mention`) |
| `botmux bots list` | List the bots in the current group (including open_id) |
| `botmux history [--limit N]` | Pull the session history (JSON) |
| `botmux quoted <message_id>` | Pull a single quoted message (JSON) |
| `botmux schedule add/list/remove/pause/resume/run` | Manage scheduled tasks |
