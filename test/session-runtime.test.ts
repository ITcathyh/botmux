import { describe, expect, it } from 'vitest';
import { computeInputHash } from '../src/utils/canonical-input-hash.js';
import { parseBotId } from '../src/core/bot-identity.js';
import {
  createSessionRuntimeHost,
  type KeyedTriggerAuthority,
  type KeyedTriggerObservation,
  type KeyedTriggerStartInput,
  type KeyedTriggerTurnPort,
  type SessionDirectory,
} from '../src/core/session-runtime.js';

class TestDirectory implements SessionDirectory {
  constructor(private readonly rows: Array<{
    key: string;
    sessionId: string;
    route: { kind: 'thread'; anchorId: string } | { kind: 'chat'; chatId: string };
    ordinaryIngressBinding: {
      scope: 'thread' | 'chat';
      canonicalAnchor: string;
      chatId: string;
      chatType: 'group' | 'p2p';
    };
    recordStatus: 'active' | 'closed';
    executorStatus: 'working' | 'idle' | 'dormant';
  }>) {}

  async read(query: Parameters<SessionDirectory['read']>[0]) {
    if (query.kind === 'list') return { kind: 'list' as const, rows: this.rows };
    const row = query.kind === 'byExternalSession'
      ? this.rows.find(candidate => candidate.sessionId === query.sessionId)
      : this.rows.find((candidate) => {
          if (candidate.route.kind === 'thread' && query.route.kind === 'thread') {
            return candidate.route.anchorId === query.route.anchorId;
          }
          if (candidate.route.kind === 'chat' && query.route.kind === 'chat') {
            return candidate.route.chatId === query.route.chatId;
          }
          return false;
        });
    return row ? { kind: 'one' as const, row } : { kind: 'notFound' as const };
  }
}

type AuthorityToken = { key: string; revision: number };

class TestKeyedTriggerAuthority implements KeyedTriggerAuthority {
  blocked = false;
  unreadable = false;
  blockAfterReserve = false;
  settlement: 'failed' | 'completed' = 'failed';
  observations = new Map<string, KeyedTriggerObservation>();
  inspections = 0;
  reserves = 0;
  begins: AuthorityToken[] = [];
  failures: AuthorityToken[] = [];

  inspect(key: string): KeyedTriggerObservation {
    this.inspections += 1;
    if (this.blocked) return { kind: 'blocked', message: 'freeze in progress' };
    if (this.unreadable) return { kind: 'unreadable', message: 'corrupt lease' };
    return this.observations.get(key) ?? { kind: 'absent', token: { key, revision: 0 } };
  }

  reserve(input: Parameters<KeyedTriggerAuthority['reserve']>[0]) {
    this.reserves += 1;
    const current = this.observations.get(input.key);
    const takingOver = current?.kind === 'present'
      && current.leaseState === 'reserved'
      && current.ownerBoot === 'other'
      && current.token === input.candidate;
    if (current?.kind === 'present' && !takingOver) {
      return { kind: 'existing' as const, observation: current };
    }
    const token = { key: input.key, revision: 1 };
    this.observations.set(input.key, {
      kind: 'present',
      token,
      requestHash: input.requestHash,
      sessionId: input.sessionId,
      triggerId: input.triggerId,
      chatId: input.chatId,
      leaseState: 'reserved',
      ownerBoot: 'current',
      terminal: 'pending',
      executorLive: false,
    });
    if (this.blockAfterReserve) this.blocked = true;
    return { kind: 'reserved' as const, token };
  }

  begin(token: unknown) {
    const typed = token as AuthorityToken;
    if (this.blocked) {
      this.observations.delete(typed.key);
      return { kind: 'retryable' as const, message: 'freeze acquired before dispatch' };
    }
    this.begins.push(typed);
    return {
      kind: 'started' as const,
      token: { ...typed, revision: typed.revision + 1 },
      pendingCreatedAt: 123,
    };
  }

  settleDispatchUnknown(token: unknown) {
    this.failures.push(token as AuthorityToken);
    return this.settlement === 'completed'
      ? { kind: 'completed' as const }
      : { kind: 'failed' as const };
  }
}

class TestKeyedTriggerTurns implements KeyedTriggerTurnPort {
  prepares = 0;
  accepts: Array<{ key: string; pendingCreatedAt: number }> = [];
  closes = 0;
  refuse = false;
  closeFails = false;
  private readonly slots = new WeakSet<object>();

  prepare(input: KeyedTriggerStartInput) {
    this.prepares += 1;
    const token = Object.freeze({});
    this.slots.add(token);
    return {
      kind: 'prepared' as const,
      turn: {
        token,
        sessionId: 'session-new',
        triggerId: 'trigger-new',
        chatId: 'http_async_new',
      },
    };
  }

  acceptAtMostOnce(token: unknown, context: { key: string; pendingCreatedAt: number }) {
    if (!token || typeof token !== 'object' || !this.slots.has(token)) {
      return { kind: 'refused' as const, message: 'foreign turn' };
    }
    this.accepts.push(context);
    return this.refuse
      ? { kind: 'refused' as const, message: 'executor refused' }
      : { kind: 'accepted' as const };
  }

  async failClose() {
    this.closes += 1;
    return this.closeFails
      ? { kind: 'unreadable' as const, message: 'close failed' }
      : { kind: 'closed' as const };
  }
}

function host(
  authority = new TestKeyedTriggerAuthority(),
  turns = new TestKeyedTriggerTurns(),
) {
  return {
    authority,
    turns,
    ...createSessionRuntimeHost({
      ownerBotId: parseBotId('bot_session_runtime_owner'),
      directory: new TestDirectory([{
        key: 'session-1',
        sessionId: 'session-1',
        route: { kind: 'thread', anchorId: 'om_root' },
        ordinaryIngressBinding: {
          scope: 'thread',
          canonicalAnchor: 'om_root',
          chatId: 'oc_chat',
          chatType: 'group',
        },
        recordStatus: 'active',
        executorStatus: 'working',
      }]),
      keyedTriggers: authority,
      keyedTriggerTurns: turns,
    }),
  };
}

const target = (key: string) => ({
  kind: 'route' as const,
  route: { kind: 'idempotency' as const, key },
});

function input(overrides: Partial<KeyedTriggerStartInput> = {}): KeyedTriggerStartInput {
  return {
    business: {
      instruction: 'do the thing',
      envelope: { format: 'text', sourceName: 'test', trusted: false },
      source: { type: 'webhook' },
      presentation: null,
      options: { asyncReturnSessionId: true },
    },
    persistInputHistory: true,
    ...overrides,
  };
}

function startCommand(overrides: Partial<KeyedTriggerStartInput> = {}) {
  return { kind: 'keyedTrigger.start' as const, input: input(overrides) };
}

function hash(overrides: Partial<KeyedTriggerStartInput> = {}): string {
  const value = input(overrides);
  return computeInputHash({
    business: value.business,
    persistInputHistory: value.persistInputHistory,
  });
}

describe('SessionRuntime address and projection boundary', () => {
  it('mints opaque epoch-scoped addresses and rejects an address from another runtime', async () => {
    const first = host();
    const projection = await first.projection.read({
      kind: 'byRoute',
      route: { kind: 'thread', anchorId: 'om_root' },
    });
    expect(projection.kind).toBe('one');
    if (projection.kind !== 'one') throw new Error('expected one row');
    expect(Object.keys(projection.session.address)).toEqual([]);
    expect(projection.session.actorRef).toEqual({
      botId: 'bot_session_runtime_owner',
      entityKind: 'session',
      entityId: 'session-1',
    });

    const second = host();
    const outcome = await second.runtime.submit({
      target: { kind: 'session', address: projection.session.address },
      idempotencyKey: 'key-1',
      command: startCommand(),
    });

    expect(outcome).toEqual({ kind: 'staleAddress' });
    expect(second.authority.inspections).toBe(0);
    expect(second.turns.prepares).toBe(0);
    const rebound = await second.projection.read({
      kind: 'byExternalSession',
      sessionId: 'session-1',
    });
    expect(rebound.kind).toBe('one');
    if (rebound.kind !== 'one') throw new Error('expected rebound row');
    expect(rebound.session.address).not.toBe(projection.session.address);
  });
});

describe('SessionRuntime keyed-trigger policy', () => {
  it('owns inspect, lazy prepare, reserve, attempt barrier, and at-most-once acceptance in one submit', async () => {
    const current = host();

    const result = await current.runtime.submit({
      target: target('key-1'),
      idempotencyKey: 'key-1',
      command: startCommand(),
    });

    expect(result).toEqual({
      kind: 'applied',
      action: 'keyedTrigger.started',
      sessionId: 'session-new',
      triggerId: 'trigger-new',
      chatId: 'http_async_new',
    });
    expect(current.authority.inspections).toBe(1);
    expect(current.turns.prepares).toBe(1);
    expect(current.authority.reserves).toBe(1);
    expect(current.authority.begins).toHaveLength(1);
    expect(current.turns.accepts).toEqual([{ key: 'key-1', pendingCreatedAt: 123 }]);
  });

  it('does not prepare a Session candidate for a duplicate, conflict, or pre-held freeze', async () => {
    const current = host();
    current.authority.observations.set('done', {
      kind: 'present', token: { key: 'done', revision: 3 }, requestHash: hash(),
      sessionId: 'done-session', triggerId: 'done-trigger', chatId: 'http_async_done',
      leaseState: 'attempting', ownerBoot: 'other', terminal: 'completed', executorLive: false,
    });
    await current.runtime.submit({ target: target('done'), idempotencyKey: 'done', command: startCommand() });

    current.authority.observations.set('conflict', {
      kind: 'present', token: { key: 'conflict', revision: 2 }, requestHash: 'different',
      sessionId: 'old', triggerId: 'old', chatId: 'http_async_old',
      leaseState: 'attempting', ownerBoot: 'other', terminal: 'pending', executorLive: false,
    });
    await current.runtime.submit({ target: target('conflict'), idempotencyKey: 'conflict', command: startCommand() });

    current.authority.blocked = true;
    await current.runtime.submit({ target: target('blocked'), idempotencyKey: 'blocked', command: startCommand() });

    expect(current.turns.prepares).toBe(0);
    expect(current.turns.accepts).toHaveLength(0);
  });

  it('rechecks admission before the attempt barrier and never accepts through a late freeze', async () => {
    const authority = new TestKeyedTriggerAuthority();
    authority.blockAfterReserve = true;
    const current = host(authority);

    const result = await current.runtime.submit({
      target: target('late-freeze'),
      idempotencyKey: 'late-freeze',
      command: startCommand(),
    });

    expect(result).toEqual({ kind: 'retryable', message: 'freeze acquired before dispatch' });
    expect(current.turns.prepares).toBe(1);
    expect(current.turns.accepts).toHaveLength(0);
    expect(authority.begins).toHaveLength(0);
    expect(authority.observations.has('late-freeze')).toBe(false);
  });

  it('rejects semantic drift and never re-dispatches an ambiguous prior attempt', async () => {
    const current = host();
    current.authority.observations.set('conflict', {
      kind: 'present', token: { key: 'conflict', revision: 2 }, requestHash: 'old-hash',
      sessionId: 'old-session', triggerId: 'old-trigger', chatId: 'http_async_old',
      leaseState: 'attempting', ownerBoot: 'other', terminal: 'pending', executorLive: false,
    });

    await expect(current.runtime.submit({
      target: target('conflict'), idempotencyKey: 'conflict', command: startCommand(),
    })).resolves.toMatchObject({ kind: 'rejected', reason: 'idempotencyConflict' });

    current.authority.observations.get('conflict')!.requestHash = hash();
    await expect(current.runtime.submit({
      target: target('conflict'), idempotencyKey: 'conflict', command: startCommand(),
    })).resolves.toMatchObject({ kind: 'ambiguous', sessionId: 'old-session', idempotent: true });

    expect(current.turns.prepares).toBe(0);
    expect(current.authority.reserves).toBe(0);
  });

  it('returns the stronger completed result when completion wins the interrupted-attempt settlement race', async () => {
    const current = host();
    current.authority.settlement = 'completed';
    current.authority.observations.set('completed-race', {
      kind: 'present', token: { key: 'completed-race', revision: 2 }, requestHash: hash(),
      sessionId: 'completed-session', triggerId: 'completed-trigger', chatId: 'http_async_completed',
      leaseState: 'attempting', ownerBoot: 'other', terminal: 'pending', executorLive: false,
    });

    const result = await current.runtime.submit({
      target: target('completed-race'),
      idempotencyKey: 'completed-race',
      command: startCommand(),
    });

    expect(result).toMatchObject({
      kind: 'duplicate',
      state: 'completed',
      sessionId: 'completed-session',
    });
    expect(current.authority.failures).toHaveLength(1);
    expect(current.turns.prepares).toBe(0);
    expect(current.turns.closes).toBe(0);
  });

  it('takes over an older reserved lease without exposing the execution port', async () => {
    const current = host();
    current.authority.observations.set('takeover', {
      kind: 'present', token: { key: 'takeover', revision: 1 }, requestHash: hash(),
      sessionId: 'old-session', triggerId: 'old-trigger', chatId: 'http_async_old',
      leaseState: 'reserved', ownerBoot: 'other', terminal: 'pending', executorLive: false,
    });

    await expect(current.runtime.submit({
      target: target('takeover'), idempotencyKey: 'takeover', command: startCommand(),
    })).resolves.toMatchObject({ kind: 'applied', action: 'keyedTrigger.started' });
    expect(current.authority.reserves).toBe(1);
    expect(current.turns.accepts).toHaveLength(1);
  });

  it('settles executor refusal as durable ambiguous and fail-closes the candidate', async () => {
    const current = host();
    current.turns.refuse = true;

    const failed = await current.runtime.submit({
      target: target('key-fail'), idempotencyKey: 'key-fail', command: startCommand(),
    });

    expect(failed).toMatchObject({
      kind: 'ambiguous', sessionId: 'session-new', triggerId: 'trigger-new',
      durable: true, idempotent: false,
    });
    expect(current.authority.failures).toHaveLength(1);
    expect(current.authority.failures[0]).toMatchObject({ revision: 2 });
    expect(current.turns.closes).toBe(1);
    expect('receipt' in failed).toBe(false);
  });

  it('does not fail-close a candidate when completion wins dispatch-failure settlement', async () => {
    const current = host();
    current.turns.refuse = true;
    current.authority.settlement = 'completed';

    const result = await current.runtime.submit({
      target: target('key-completed'),
      idempotencyKey: 'key-completed',
      command: startCommand(),
    });

    expect(result).toMatchObject({ kind: 'duplicate', state: 'completed', sessionId: 'session-new' });
    expect(current.authority.failures).toHaveLength(1);
    expect(current.turns.closes).toBe(0);
  });

  it('quarantines a candidate when fail-close cannot converge', async () => {
    const current = host();
    current.turns.refuse = true;
    current.turns.closeFails = true;

    await expect(current.runtime.submit({
      target: target('close-fail'), idempotencyKey: 'close-fail', command: startCommand(),
    })).resolves.toMatchObject({ kind: 'quarantined', message: expect.stringContaining('fail-close') });
  });

  it('rejects invalid targets before any authority or turn side effect', async () => {
    const current = host();
    const result = await current.runtime.submit({
      target: { kind: 'route', route: { kind: 'chat', chatId: 'oc_other' } },
      idempotencyKey: 'key-1',
      command: startCommand(),
    });

    expect(result).toMatchObject({ kind: 'rejected', reason: 'invalidCommand' });
    expect(current.authority.inspections).toBe(0);
    expect(current.authority.reserves).toBe(0);
    expect(current.turns.prepares).toBe(0);
  });

  it('rejects a blank idempotency key before any authority or turn side effect', async () => {
    const current = host();
    const result = await current.runtime.submit({
      target: target('blank-key'),
      idempotencyKey: '   ',
      command: startCommand(),
    });

    expect(result).toMatchObject({ kind: 'rejected', reason: 'invalidCommand' });
    expect(current.authority.inspections).toBe(0);
    expect(current.authority.reserves).toBe(0);
    expect(current.turns.prepares).toBe(0);
  });

  it('rejects a non-canonicalizable semantic input before touching authority', async () => {
    const current = host();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    const result = await current.runtime.submit({
      target: target('cyclic'),
      idempotencyKey: 'cyclic',
      command: startCommand({
        business: {
          ...input().business,
          source: cyclic,
        },
      }),
    });

    expect(result).toMatchObject({ kind: 'rejected', reason: 'invalidCommand' });
    expect(current.authority.inspections).toBe(0);
    expect(current.authority.reserves).toBe(0);
    expect(current.turns.prepares).toBe(0);
  });
});
