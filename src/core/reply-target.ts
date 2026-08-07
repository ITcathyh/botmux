import type { DaemonSession } from './types.js';
import type { ReplyTargetEntry, Session, TurnParticipant } from '../types.js';

/** Merge participants by open_id, keeping the richest label (a later entry can
 *  fill a missing name / promote isBot). Order-stable on first appearance so a
 *  candidate list reads in arrival order. */
export function dedupeParticipants(list: TurnParticipant[]): TurnParticipant[] {
  const byId = new Map<string, TurnParticipant>();
  for (const p of list) {
    if (!p?.openId) continue;
    const prev = byId.get(p.openId);
    if (!prev) { byId.set(p.openId, { openId: p.openId, ...(p.name ? { name: p.name } : {}), ...(p.isBot !== undefined ? { isBot: p.isBot } : {}) }); continue; }
    if (!prev.name && p.name) prev.name = p.name;
    if (prev.isBot === undefined && p.isBot !== undefined) prev.isBot = p.isBot;
    if (p.isBot === true) prev.isBot = true; // a bot signal from any message wins
  }
  return [...byId.values()];
}

export type SessionReplyTarget =
  | { mode: 'plain'; chatId: string }
  | { mode: 'thread'; rootMessageId: string }
  | { mode: 'quote'; rootMessageId: string };

/** Bound on `Session.replyTargets`: long-lived sessions could otherwise grow
 * without limit. An evicted turn may use a legacy slot only when its turnId
 * still matches exactly; it never borrows a later turn's sender. */
const REPLY_TARGETS_MAX = 32;

export interface TurnReplyTarget extends Omit<ReplyTargetEntry, 'updatedAt'> {
  turnId: string;
  updatedAt?: string;
}

/** Reply context for one exact turn. The per-turn entry is authoritative. Old
 * persisted sessions may fall back to the single slots only when those slots
 * explicitly identify the requested turn. */
export function pickTurnReplyTarget(
  s: Pick<Session, 'replyTargets' | 'currentReplyTarget' | 'quoteTargetId' | 'quoteTargetSenderOpenId'>,
  currentTurnId: string | undefined,
): TurnReplyTarget | undefined {
  if (currentTurnId) {
    const entry = s.replyTargets?.[currentTurnId];
    // Legacy single-slot sender is trusted only when it explicitly names THIS
    // turn (quoteTargetId === currentTurnId), so it never borrows a later
    // turn's attribution.
    const legacySender = s.quoteTargetId === currentTurnId
      ? s.quoteTargetSenderOpenId
      : undefined;
    if (entry) {
      const senderOpenId = entry.senderOpenId ?? legacySender;
      return { ...entry, turnId: currentTurnId, ...(senderOpenId ? { senderOpenId } : {}) };
    }
    const slot = s.currentReplyTarget?.turnId === currentTurnId
      ? s.currentReplyTarget
      : undefined;
    if (slot || legacySender) {
      return { ...slot, turnId: currentTurnId, ...(legacySender ? { senderOpenId: legacySender } : {}) };
    }
    return undefined;
  }
  return s.currentReplyTarget;
}

/** Whether `turnId` is a chat-scope substitute turn that disables the
 * streaming card. Thread-scope substitute turns keep their normal card. With
 * no turn context, falls back to the latest-accepted chat turn's flag; callers
 * with a turnId get an exact per-turn answer so queued normal/substitute turns
 * cannot inherit each other's card state. */
export function isSubstituteTurn(
  ds: Pick<DaemonSession, 'scope' | 'session' | 'currentReplyTarget'>,
  turnId?: string,
): boolean {
  // Substitute (avatar-style) turns are a chat-scope-only concept: topic-group
  // substitute sessions are thread-scope and keep their normal streaming card.
  // Defense-in-depth alongside beginReplyTargetTurn NOT persisting the flag for
  // thread scope — a thread-scope session is never card-off via this path.
  if (ds.scope !== 'chat') return false;
  const slot = ds.currentReplyTarget ?? ds.session.currentReplyTarget;
  if (turnId) {
    const entry = ds.session.replyTargets?.[turnId];
    if (entry) return entry.substitute === true;
    // With explicit turn context, the single slot only speaks for ITS OWN
    // turn. It must not inherit a later turn's flag after that turn overwrote
    // the slot (and vice versa).
    return !!slot && slot.turnId === turnId && slot.substitute === true;
  }
  return slot?.substitute === true;
}

export function resolveSessionReplyTarget(
  ds: Pick<DaemonSession, 'scope' | 'chatId' | 'session' | 'currentReplyTarget'>,
  turnId?: string,
): SessionReplyTarget {
  if (ds.scope === 'chat') {
    // Exact per-turn anchor first: survives a later turn overwriting the
    // single slot while this turn is still executing/queued.
    const turnEntry = turnId ? ds.session.replyTargets?.[turnId] : undefined;
    if (turnEntry?.rootMessageId) {
      return turnEntry.quoteOnly
        ? { mode: 'quote', rootMessageId: turnEntry.rootMessageId }
        : { mode: 'thread', rootMessageId: turnEntry.rootMessageId };
    }
    const target = ds.currentReplyTarget ?? ds.session.currentReplyTarget;
    if (target?.rootMessageId && !!turnId && target.turnId === turnId) {
      return target.quoteOnly
        ? { mode: 'quote', rootMessageId: target.rootMessageId }
        : { mode: 'thread', rootMessageId: target.rootMessageId };
    }
    return { mode: 'plain', chatId: ds.chatId };
  }
  return { mode: 'thread', rootMessageId: ds.session.rootMessageId };
}

export function resolveSendTarget(opts: {
  into?: string;
  topLevel: boolean;
  chatScope: boolean;
  chatId: string;
  rootMessageId: string;
  replyTargetRootId?: string;
  replyTargetTurnId?: string;
  replyTargetQuoteOnly?: boolean;
  currentTurnId?: string;
}): SessionReplyTarget {
  if (opts.into) return { mode: 'thread', rootMessageId: opts.into };
  if (opts.topLevel) return { mode: 'plain', chatId: opts.chatId };
  if (opts.chatScope) {
    if (opts.replyTargetRootId && opts.replyTargetTurnId && opts.replyTargetTurnId === opts.currentTurnId) {
      return opts.replyTargetQuoteOnly
        ? { mode: 'quote', rootMessageId: opts.replyTargetRootId }
        : { mode: 'thread', rootMessageId: opts.replyTargetRootId };
    }
    return { mode: 'plain', chatId: opts.chatId };
  }
  return { mode: 'thread', rootMessageId: opts.rootMessageId };
}

export function beginReplyTargetTurn(
  ds: DaemonSession,
  replyRootId: string | undefined,
  turnId: string,
  nowIso = new Date().toISOString(),
  opts?: { quoteOnly?: boolean; substitute?: boolean; senderOpenId?: string; participants?: TurnParticipant[] },
): void {
  // Routing and sender are one atomic per-turn record. Thread-scope and
  // rootless chat turns may have no rootMessageId, but still require their
  // exact sender for --mention-back. Sender attribution (senderOpenId) and the
  // turn-window participant set are written in ANY scope — bot→bot handoff
  // happens in threads too. Everything else is chat-scope-only: quoteOnly/
  // substitute are chat-scope semantics (topic-group substitute keeps its
  // normal card; footer substitute addressing only applies to the shared
  // chat-scope session), and a thread-scope turn routes off
  // session.rootMessageId, never a per-turn root. So a thread entry carries
  // ONLY sender attribution + participants + updatedAt — no chat routing
  // metadata can leak in, or readers (isSubstituteTurn, footer isSubstitute)
  // would misread it.
  const isChatScope = ds.scope === 'chat';
  const targets = { ...(ds.session.replyTargets ?? {}) };
  targets[turnId] = {
    ...(isChatScope && replyRootId ? { rootMessageId: replyRootId } : {}),
    updatedAt: nowIso,
    ...(isChatScope ? { quoteOnly: opts?.quoteOnly, substitute: opts?.substitute } : {}),
    ...(opts?.senderOpenId ? { senderOpenId: opts.senderOpenId } : {}),
    ...(opts?.participants?.length ? { participants: dedupeParticipants(opts.participants) } : {}),
  };
  const keys = Object.keys(targets);
  if (keys.length > REPLY_TARGETS_MAX) {
    keys
      .sort((a, b) => (targets[a].updatedAt < targets[b].updatedAt ? -1 : 1))
      .slice(0, keys.length - REPLY_TARGETS_MAX)
      .forEach(k => { delete targets[k]; });
  }
  ds.session.replyTargets = targets;

  if (ds.scope !== 'chat') return;
  if (replyRootId) {
    const aliases = { ...(ds.replyThreadAliases ?? ds.session.replyThreadAliases ?? {}) };
    aliases[replyRootId] = {
      createdAt: aliases[replyRootId]?.createdAt ?? nowIso,
      lastUsedAt: nowIso,
    };
    const target = { rootMessageId: replyRootId, turnId, updatedAt: nowIso, quoteOnly: opts?.quoteOnly, substitute: opts?.substitute };
    ds.replyThreadAliases = aliases;
    ds.currentReplyTarget = target;
    ds.session.replyThreadAliases = aliases;
    ds.session.currentReplyTarget = target;
    return;
  }
  ds.currentReplyTarget = undefined;
  ds.session.currentReplyTarget = undefined;
}

/** Window within which sibling turn records are treated as the SAME turn for
 *  --mention-back ambiguity. Type-ahead follow-ups each land as their own
 *  per-turn record (distinct message_id), and the model may resolve
 *  BOTMUX_TURN_ID to whichever was processed last — so `botmux send` unions the
 *  participants of every record updated within this window of the resolved
 *  turn. Deliberately an approximation (申晗-approved): erring wide can only add
 *  a candidate / over-suggest an explicit --mention, never wrongly auto-@ the
 *  wrong person (fail-safe). 90s comfortably spans a busy CLI batch while not
 *  bleeding into an unrelated later conversation. */
export const TURN_WINDOW_MS = 90_000;

/** The turn-window counterpart set for `currentTurnId`: the resolved turn's own
 *  participants unioned with those of any sibling turn record updated within
 *  TURN_WINDOW_MS (covers type-ahead follow-ups that folded into this model
 *  turn under different message_ids). Empty array when nothing is known. */
export function collectTurnWindowParticipants(
  s: Pick<Session, 'replyTargets'>,
  currentTurnId: string | undefined,
): TurnParticipant[] {
  const map = s.replyTargets;
  if (!map || !currentTurnId) return [];
  const anchor = map[currentTurnId];
  if (!anchor) return [];
  const anchorMs = Date.parse(anchor.updatedAt);
  const collected: TurnParticipant[] = [];
  for (const entry of Object.values(map)) {
    if (!entry.participants?.length) continue;
    const ms = Date.parse(entry.updatedAt);
    // Include the anchor itself and any record within the window on either side
    // (a follow-up may be stamped slightly before or after the anchor).
    if (Number.isNaN(ms) || Number.isNaN(anchorMs) || Math.abs(ms - anchorMs) <= TURN_WINDOW_MS) {
      collected.push(...entry.participants);
    }
  }
  return dedupeParticipants(collected);
}


/**
 * Effective turnId for a daemon-side message. Callers that know their turn
 * (worker final_output, placeholder cards) pass it explicitly and the
 * stale-turn gate in resolveSessionReplyTarget stays authoritative. Callers
 * with NO turn context of their own (the worker's first streaming card,
 * crash notices) fall back to the session's current reply-target turn — in a
 * shared fold-back topic they then follow the conversation into the thread
 * instead of leaking to the chat top level.
 */
export function fallbackTurnId(
  ds: Pick<DaemonSession, 'session' | 'currentReplyTarget'>,
  turnId: string | undefined,
): string | undefined {
  return turnId ?? (ds.currentReplyTarget ?? ds.session.currentReplyTarget)?.turnId;
}

export function syncReplyTargetState(ds: DaemonSession, s?: Session): void {
  const source = s ?? ds.session;
  ds.replyThreadAliases = source.replyThreadAliases;
  ds.currentReplyTarget = source.currentReplyTarget;
}
