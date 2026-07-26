# riff-cli-runner protocol fixture (headless PTY CLI runner)

Same NDJSON JSON-RPC shape as `riff-codex-runner` — riff drives both with one
adapter + one channel codec, dispatching by CLI class. `>>>` = riff→bin (stdin,
request, has `id`). `<<<` = bin→riff (stdout, notification, no `id`) or a
response (`id` + `result`/`error`). One JSON object per line.

Transport: spawn the bin, write requests to stdin, read notifications+responses
off stdout. The bin forks botmux's `worker.js` (resolved next to the bin;
override with `RIFF_WORKER_PATH`) with an inline profile — no bots.json, no bot
registration, no Feishu.

## 1. Happy path — run(claude-code) → running → output → completed

```
>>> {"jsonrpc":"2.0","id":1,"method":"run","params":{"cliId":"claude-code","cwd":"/workspace/proj","prompt":"Summarize the repo","model":"..."}}
<<< {"jsonrpc":"2.0","id":1,"result":{"ok":true,"sessionId":"0ffbcebf-f528-414b-ab6f-e1e549a3e7bd"}}
<<< {"jsonrpc":"2.0","method":"status","params":{"state":"running"}}
<<< {"jsonrpc":"2.0","method":"output","params":{"content":"...incremental agent text..."}}
<<< {"jsonrpc":"2.0","method":"completed","params":{"content":"<final answer>","sessionId":"cs_<claude-native-id>"}}
```

- `id:1` response is the **ACK** — turn accepted/started, returned as soon as the
  worker is forked + init sent. NOT the final result.
- `run.sessionId` in the ACK is the botmux session id; `completed.sessionId` is
  the CLI-native resume id (claude's session id) — **use that for follow-up**.
- `output` is incremental agent text (may be zero/many; see caveat below).

## 2. Follow-up — resume the prior session

```
>>> {"jsonrpc":"2.0","id":2,"method":"run","params":{"cliId":"claude-code","cwd":"/workspace/proj","prompt":"<answer to the question>","sessionId":"cs_<from completed above>"}}
<<< {"jsonrpc":"2.0","id":2,"result":{"ok":true,"sessionId":"..."}}
<<< {"jsonrpc":"2.0","method":"status","params":{"state":"running"}}
<<< {"jsonrpc":"2.0","method":"completed","params":{"content":"...","sessionId":"cs_..."}}
```

- Passing `sessionId` triggers the worker's `--resume` path: a fresh process,
  context reloaded from the CLI's on-disk transcript. This is X lifecycle
  (one task per process) — no long-lived daemon. Mirrors codex's `threadId`.

## 3. Cancel (idempotent ack)

```
>>> {"jsonrpc":"2.0","id":9,"method":"cancel","params":{}}
<<< {"jsonrpc":"2.0","id":9,"result":{"ok":true,"cancelled":true}}
```

## 4. Failure

```
>>> {"jsonrpc":"2.0","id":1,"method":"run","params":{"cliId":"claude-code","cwd":"/workspace","prompt":"x"}}
<<< {"jsonrpc":"2.0","id":1,"result":{"ok":true,"sessionId":"..."}}
<<< {"jsonrpc":"2.0","method":"failed","params":{"errorCode":"worker_error","error":"..."}}
```

Terminal `failed.errorCode`: `worker_error` (worker emitted error), `cli_exited`
(CLI died before final output), `worker_exited`, `cancelled`, `dispatch_failed`.
Request `error.code`: -32602 bad params, -32601 unknown method, -32000 turn in
flight, -32001 worker spawn failed, -32002 init send failed.

## ⚠️ Two honest caveats (v1 status)

1. **Verified against a FAKE worker, not real claude-code yet.** The integration
   test drives a fake `worker.js` that speaks the botmux `WorkerToDaemon` IPC
   (ready / prompt_ready / cli_session_id / final_output / error). It proves the
   runner↔worker↔riff translation + resume + failure paths. It does NOT yet
   prove a real claude-code turn end-to-end (needs a real CLI + creds in the
   sandbox — riff's environment). That's the next step to run together.

2. **`completed.usage` is not populated for claude-code yet.** For claude-code,
   token usage lives in the transcript and is computed daemon-side (cost-calculator),
   which this headless path doesn't wire yet. `usage` is emitted only if the
   worker provides it inline (future). If riff needs claude-code usage in v1,
   tell me — I can add a transcript read on `final_output` like the async
   trigger-result path does. Codex usage (via the codex runner) is unaffected.
