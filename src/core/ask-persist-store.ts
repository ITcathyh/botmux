/**
 * ask-persist-store — file-backed pending `botmux ask` state.
 *
 * Why this exists: the ask broker's pending registry is an in-memory Map, so a
 * daemon restart between "card posted" and "user clicked" loses the ask. The
 * user's later click then hits `stale` ("此 ask 已失效"), and the CLI hook that
 * was blocking on `/api/asks` has meanwhile dropped its connection and fallen
 * back to passthrough → the CLI renders its native picker with no way to deliver
 * the answer. (See the AskUserQuestion picker-desync investigation.)
 *
 * This module owns the durable projection of each pending ask under
 * `<dataDir>/asks/<askKey>.json`. The broker persists on create, removes on
 * settle, and on boot re-hydrates them as "dormant" asks (card still live in
 * Feishu, but no waiter yet). When the surviving CLI hook reconnects and
 * re-POSTs the same ask, the broker matches it by `askKey` and re-attaches a
 * fresh waiter Promise + timeout to the dormant entry — so the answer flows back
 * through the normal hook directive, no native picker, no keystroke driving.
 *
 * Design mirrors `workflows/v3/gate-wait-store.ts` (also "survive restart"):
 * atomic writes, fsync durability, a `listPersistedAsks` restore scan. Kept
 * bot-agnostic and pure file IO so it's testable without the daemon.
 *
 * `askKey` is a STABLE identity for an ask across restarts: derived by the
 * caller (daemon) from `BOTMUX_SESSION_ID` (unchanged across a daemon restart —
 * it is the CLI process's spawn-time env) + a hash of the questions. The
 * reconnecting hook, being the same CLI process, recomputes the identical key
 * and so re-attaches to its own dormant ask rather than posting a duplicate
 * card.
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';

import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { AskQuestion } from './ask-types.js';

/** Persisted shape — everything needed to re-hydrate a dormant ask + re-render
 *  its card. Deliberately excludes runtime-only fields (resolve fn, timers). */
export interface PersistedAsk {
  /** Schema version so a future field change can migrate/skip cleanly. */
  v: 1;
  /** Stable cross-restart identity (see module doc). */
  askKey: string;
  /** The random per-process askId assigned when first registered. Retained so a
   *  restored ask keeps a stable id for logging/snapshots; a re-attach keeps it. */
  askId: string;
  nonce: string;
  larkAppId: string;
  chatId: string;
  rootMessageId: string | null;
  sessionId: string;
  chatType?: 'group' | 'p2p';
  questions: ReadonlyArray<AskQuestion>;
  createdAt: number;
  deadlineAt: number;
  /** Feishu message id of the posted card, once dispatch landed. Undefined until
   *  the card send resolves; a restored ask without it can still be re-sent. */
  cardMessageId?: string;
  /** Accumulated per-question selections (checkbox state), so a restart mid-
   *  multi-select keeps the boxes the user already ticked. */
  selections: ReadonlyArray<ReadonlyArray<string>>;
}

/** Compute the stable cross-restart key for an ask. Same session + same
 *  questions → same key, so a reconnecting hook re-attaches deterministically.
 *  The questions hash guards against two concurrent asks from one session
 *  colliding (rare, but possible if a CLI fires two AskUserQuestion in flight).
 */
export function computeAskKey(sessionId: string, questions: ReadonlyArray<AskQuestion>): string {
  const shape = JSON.stringify(
    questions.map((q) => ({
      p: q.prompt,
      m: !!q.multiSelect,
      o: q.options.map((o) => o.key),
    })),
  );
  const h = createHash('sha256').update(shape).digest('hex').slice(0, 16);
  // sessionId is already filesystem-safe (uuid-ish); keep it readable in the
  // filename, append the questions hash for collision resistance.
  return `${sanitizeKeySegment(sessionId)}.${h}`;
}

/** Keep a key segment safe as a path component (no separators / traversal). */
function sanitizeKeySegment(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
}

function asksDir(): string {
  return join(config.session.dataDir, 'asks');
}

function askFilePath(askKey: string): string {
  return join(asksDir(), `${sanitizeKeySegment(askKey)}.json`);
}

/** Persist (create or update) a pending ask. Called on register and whenever
 *  cardMessageId / selections change so a restart mid-interaction is faithful.
 *  Best-effort durable: atomic rename + fsync via atomicWriteFileSync. */
export function persistAsk(ask: PersistedAsk): void {
  try {
    mkdirSync(asksDir(), { recursive: true });
    atomicWriteFileSync(askFilePath(ask.askKey), JSON.stringify(ask), { mode: 0o600, durable: true });
  } catch (e) {
    // Persistence is a resilience enhancement, never a correctness gate for the
    // live path: a failed write just means this ask won't survive a restart.
    logger.warn?.(
      `ask-persist: failed to persist ${ask.askKey}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** Remove a persisted ask (on settle: answered / timed out / invalidated).
 *  Idempotent — a missing file is not an error. */
export function removePersistedAsk(askKey: string): void {
  try {
    unlinkSync(askFilePath(askKey));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    logger.warn?.(
      `ask-persist: failed to remove ${askKey}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** Load all persisted asks for restart recovery. Skips corrupt / wrong-version
 *  / already-expired entries (and reaps the expired files). Never throws — a
 *  bad store must not block daemon boot. */
export function listPersistedAsks(now: number = Date.now()): PersistedAsk[] {
  const dir = asksDir();
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch (e) {
    logger.warn?.(
      `ask-persist: cannot read ${dir}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return [];
  }
  const out: PersistedAsk[] = [];
  for (const name of names) {
    const fp = join(dir, name);
    let parsed: PersistedAsk | undefined;
    try {
      parsed = JSON.parse(readFileSync(fp, 'utf-8')) as PersistedAsk;
    } catch {
      // Corrupt/racing write — drop it so it can't wedge recovery.
      try { unlinkSync(fp); } catch { /* ignore */ }
      continue;
    }
    if (!parsed || parsed.v !== 1 || !parsed.askKey || !Array.isArray(parsed.questions)) {
      try { unlinkSync(fp); } catch { /* ignore */ }
      continue;
    }
    if (typeof parsed.deadlineAt === 'number' && parsed.deadlineAt <= now) {
      // Already past its deadline while the daemon was down — nothing to resume.
      try { unlinkSync(fp); } catch { /* ignore */ }
      continue;
    }
    out.push(parsed);
  }
  return out;
}
