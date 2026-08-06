import type { DaemonSession } from './types.js';
import type { ReplyTargetEntry, Session } from '../types.js';

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
  s: Pick<Session, 'replyTargets' | 'currentReplyTarget' | 'quoteTargetId' | 'quoteTargetSenderOpenId' | 'quoteTargetSenderIsBot'>,
  currentTurnId: string | undefined,
): TurnReplyTarget | undefined {
  if (currentTurnId) {
    const entry = s.replyTargets?.[currentTurnId];
    // Legacy single-slot sender is trusted only when it explicitly names THIS
    // turn (quoteTargetId === currentTurnId); the is-bot flag rides the same
    // gate so it never borrows a later turn's attribution.
    const legacyMatches = s.quoteTargetId === currentTurnId;
    const legacySender = legacyMatches ? s.quoteTargetSenderOpenId : undefined;
    const legacyIsBot = legacyMatches ? s.quoteTargetSenderIsBot : undefined;
    if (entry) {
      const senderOpenId = entry.senderOpenId ?? legacySender;
      const senderIsBot = entry.senderIsBot ?? (entry.senderOpenId ? undefined : legacyIsBot);
      return {
        ...entry,
        turnId: currentTurnId,
        ...(senderOpenId ? { senderOpenId } : {}),
        ...(senderIsBot !== undefined ? { senderIsBot } : {}),
      };
    }
    const slot = s.currentReplyTarget?.turnId === currentTurnId
      ? s.currentReplyTarget
      : undefined;
    if (slot || legacySender) {
      return {
        ...slot,
        turnId: currentTurnId,
        ...(legacySender ? { senderOpenId: legacySender } : {}),
        ...(legacySender && legacyIsBot !== undefined ? { senderIsBot: legacyIsBot } : {}),
      };
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
  opts?: { quoteOnly?: boolean; substitute?: boolean; senderOpenId?: string; senderIsBot?: boolean },
): void {
  // Routing and sender are one atomic per-turn record. Thread-scope and
  // rootless chat turns may have no rootMessageId, but still require their
  // exact sender for --mention-back. Sender attribution (senderOpenId +
  // senderIsBot) is written in ANY scope — bot→bot handoff happens in threads
  // too. Everything else is chat-scope-only: quoteOnly/substitute are
  // chat-scope semantics (topic-group substitute keeps its normal card; footer
  // substitute addressing only applies to the shared chat-scope session), and a
  // thread-scope turn routes off session.rootMessageId, never a per-turn root.
  // So a thread entry carries ONLY sender attribution + updatedAt — no chat
  // routing metadata can leak in, or readers (isSubstituteTurn, footer
  // isSubstitute) would misread it.
  const isChatScope = ds.scope === 'chat';
  const targets = { ...(ds.session.replyTargets ?? {}) };
  targets[turnId] = {
    ...(isChatScope && replyRootId ? { rootMessageId: replyRootId } : {}),
    updatedAt: nowIso,
    ...(isChatScope ? { quoteOnly: opts?.quoteOnly, substitute: opts?.substitute } : {}),
    ...(opts?.senderOpenId ? { senderOpenId: opts.senderOpenId } : {}),
    ...(opts?.senderIsBot !== undefined ? { senderIsBot: opts.senderIsBot } : {}),
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
