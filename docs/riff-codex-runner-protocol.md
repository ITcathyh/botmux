# riff-codex-runner protocol fixture

Line-delimited JSON (NDJSON) exchange between riff's task-runner and the
`riff-codex-runner` bin. `>>>` = riff→bin (stdin, JSON-RPC **request**, has `id`).
`<<<` = bin→riff (stdout, JSON-RPC **notification**, no `id`) or a **response**
to a request (`id` + `result`/`error`). One JSON object per line.

Transport: spawn the bin, write requests to its stdin, read notifications +
responses off its stdout, both NDJSON. codex binary resolved via `RIFF_CODEX_BIN`
(default `codex`). Model routing / provider / token come from `~/.codex/config.toml`
in the sandbox — the bin never sets them.

## 1. Happy path (run → running → output → completed)

```
>>> {"jsonrpc":"2.0","id":1,"method":"run","params":{"prompt":"Summarize repo","model":"gpt-5-codex","reasoningEffort":"high","cwd":"/workspace/proj"}}
<<< {"jsonrpc":"2.0","id":1,"result":{"ok":true,"threadId":"thr_abc"}}
<<< {"jsonrpc":"2.0","method":"status","params":{"state":"running"}}
<<< {"jsonrpc":"2.0","method":"output","params":{"content":"Looking at the "}}
<<< {"jsonrpc":"2.0","method":"output","params":{"content":"repository...\n"}}
<<< {"jsonrpc":"2.0","method":"completed","params":{"content":"The repo is a ...","usage":{"inputTokens":1200,"outputTokens":340,"cacheReadTokens":800,"cacheCreateTokens":0}}}
```

- `id:1` response is the **ACK** — turn accepted/started, returned immediately.
  The final answer is NOT in it; it arrives later as `completed`.
- `output` notifications are incremental agent text (may be zero or many).
- `completed.usage` may be absent if codex's transcript carries no usage.

## 2. Clarification round-trip (awaiting_input → answer → completed)

> **v1 default: OFF.** In-turn `requestUserInput`/`elicitation` are turn-scoped
> blocking requests in codex — answering them requires a same-turn respond, which
> would hang the turn (and the bin + codex process) waiting for a human. That
> conflicts with riff's turn-ending model + sandbox recovery, and riff's own
> codex path never uses it (clarifications are turn-ending: the model emits the
> question as its final message, the turn completes, riff does a follow-up run).
> So by default the bin **auto-skips** in-turn interactions (answers codex with an
> empty/cancel result) and the turn runs to `completed`/`failed` — you never see
> `awaiting_input`. Clarifications surface as ordinary completed content, and you
> answer via a follow-up `run { threadId, prompt: <answer> }`.
>
> The exchange below only happens under **`RIFF_CODEX_INTERACTIVE=1`** (v2 opt-in;
> also needs a suspended-turn + recovery design on the caller side). The parsing
> is documented for when v2 lands, but v1 adapters can ignore `awaiting_input`.

```
>>> {"jsonrpc":"2.0","id":1,"method":"run","params":{"prompt":"Deploy the service","cwd":"/workspace/proj"}}
<<< {"jsonrpc":"2.0","id":1,"result":{"ok":true,"threadId":"thr_abc"}}
<<< {"jsonrpc":"2.0","method":"status","params":{"state":"running"}}
<<< {"jsonrpc":"2.0","method":"awaiting_input","params":{"interactionId":"int_1","kind":"clarification","question":"Which environment? (prod/staging)"}}
>>> {"jsonrpc":"2.0","id":2,"method":"answer","params":{"interactionId":"int_1","text":"staging"}}
<<< {"jsonrpc":"2.0","id":2,"result":{"ok":true}}
<<< {"jsonrpc":"2.0","method":"status","params":{"state":"running"}}
<<< {"jsonrpc":"2.0","method":"completed","params":{"content":"Deployed to staging.","usage":{"inputTokens":900,"outputTokens":120,"cacheReadTokens":0,"cacheCreateTokens":0}}}
```

- `awaiting_input` is NON-terminal: keep polling / keep the task Running.
- `kind` ∈ `clarification` (requestUserInput) | `confirmation` (elicitation) |
  `authentication` (login/OAuth elicitation with `authChallenge`).
- `answer.text` is free text; the bin maps it back to codex (single-field
  `answers` for requestUserInput, `accept`+content for elicitation).
- `answer` response `id:2`: `result.ok=true` = injected; `error` = interaction no
  longer pending (e.g. turn already failed/timed out) → prompt user to retry.

## 3. Authentication interaction (with authChallenge)

```
<<< {"jsonrpc":"2.0","method":"awaiting_input","params":{"interactionId":"int_2","kind":"authentication","question":"Sign in to continue","authChallenge":{"links":[{"url":"https://auth.example/device","label":"Open login"}],"userCode":"WXYZ-1234","instructions":"Enter the code after signing in","expiresAt":"2026-07-26T12:00:00Z"}}}
>>> {"jsonrpc":"2.0","id":3,"method":"answer","params":{"interactionId":"int_2","text":"done"}}
<<< {"jsonrpc":"2.0","id":3,"result":{"ok":true}}
```

## 4. Cancel (idempotent ack)

```
>>> {"jsonrpc":"2.0","id":9,"method":"cancel","params":{}}
<<< {"jsonrpc":"2.0","id":9,"result":{"ok":true,"cancelled":true}}
```

- Always acked, even if no turn is live (`cancelled:false` then).
- If a turn was live it is torn down and you'll also see a
  `failed{errorCode:"cancelled"}` notification for that turn.

## 5. Failure (run rejected / turn failed)

```
>>> {"jsonrpc":"2.0","id":1,"method":"run","params":{"prompt":"x","cwd":"/nope"}}
<<< {"jsonrpc":"2.0","id":1,"error":{"code":-32001,"message":"codex initialize failed: ..."}}
```

or, after a successful ack, a mid-turn failure:

```
<<< {"jsonrpc":"2.0","method":"failed","params":{"errorCode":"turn_failed","error":"model error: ..."}}
```

- `run` `error` response = turn never started (bad spawn / init) → terminal, no
  notification follows.
- `failed` notification = turn started then died → terminal.

## Error codes (response `error.code`)

| code | meaning |
|------|---------|
| -32602 | bad params (missing prompt/cwd/interactionId) |
| -32601 | unknown method |
| -32000 | a turn is already in flight (one turn at a time) |
| -32001 | codex initialize failed (spawn/handshake) |
| -32002 | turn start failed |
| -32003 | interaction no longer pending (answer arrived too late) |
| -32004 | answer injection failed |
