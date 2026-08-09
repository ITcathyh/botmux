import { describe, expect, it, vi } from 'vitest';

import {
  createCurrentOrdinaryImTurnPreparationPort,
  type CurrentOrdinaryImTurnPreparationPort,
  type PreparedOrdinaryImTurn,
} from '../src/core/current-ordinary-im-turn.js';
import {
  createCurrentOrdinaryIngressPort,
  type CurrentOrdinaryIngressBoundaryDriver,
} from '../src/core/current-ordinary-ingress.js';
import {
  normalizeOrdinaryImTurn,
  type OrdinaryImTransportEnvelope,
} from '../src/core/ordinary-im-turn.js';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';
import type { Session } from '../src/types.js';

vi.mock('../src/services/session-store.js', () => ({ updateSession: vi.fn() }));

const OWNER = 'app-owner';

function envelope(): OrdinaryImTransportEnvelope {
  return {
    route: {
      scope: 'thread',
      canonicalAnchor: 'om_root',
      chatId: 'oc_chat',
      chatType: 'group',
    },
    source: 'lark.im',
    messageKey: 'om_compiler_contract',
    content: 'exact content',
    sender: { kind: 'human', openId: 'ou_sender', name: 'Sender' },
    attachments: [{
      type: 'image',
      resourceKey: 'img_resource',
      name: 'image.png',
    }],
    mentions: [{ key: '@_user', name: 'Mention', openId: 'ou_mention', kind: 'human' }],
  };
}

function daemonSession(): DaemonSession {
  const session = {
    sessionId: 'session-1',
    larkAppId: OWNER,
    rootMessageId: 'om_root',
    chatId: 'oc_chat',
    chatType: 'group',
    scope: 'thread',
    status: 'active',
    title: 'Session',
    createdAt: '2026-08-10T00:00:00.000Z',
  } as Session;
  return {
    session,
    worker: { killed: false } as DaemonSession['worker'],
    workerPort: null,
    workerToken: null,
    larkAppId: OWNER,
    chatId: 'oc_chat',
    chatType: 'group',
    scope: 'thread',
    spawnedAt: 0,
    cliVersion: 'test',
    lastMessageAt: 0,
    hasHistory: false,
  } as DaemonSession;
}

function clonePrepared(
  turn: PreparedOrdinaryImTurn,
  replacements: Partial<Record<keyof PreparedOrdinaryImTurn, unknown>> = {},
  prototype: object | null = Object.getPrototypeOf(turn),
): PreparedOrdinaryImTurn {
  const descriptors = Object.getOwnPropertyDescriptors(turn);
  for (const [key, value] of Object.entries(replacements)) {
    descriptors[key] = {
      value,
      enumerable: true,
      configurable: false,
      writable: false,
    };
  }
  return Object.freeze(Object.create(prototype, descriptors)) as PreparedOrdinaryImTurn;
}

function driver(): CurrentOrdinaryIngressBoundaryDriver {
  const accepted = vi.fn(async () => ({ kind: 'accepted' as const }));
  return {
    sendLive: accepted,
    parkOpeningFollower: accepted,
    parkPendingRepoFollower: accepted,
    startColdReplacement: accepted,
    startQueuedActivation: accepted,
    recoverParkedActivation: accepted,
  };
}

describe('Current ordinary ingress compiler contract', () => {
  it.each([
    {
      name: 'top-level authority field',
      mutate(turn: PreparedOrdinaryImTurn) {
        const copy = Object.create(
          Object.getPrototypeOf(turn),
          Object.getOwnPropertyDescriptors(turn),
        );
        Object.defineProperty(copy, 'generation', {
          value: 7,
          enumerable: true,
          configurable: false,
          writable: false,
        });
        return Object.freeze(copy) as PreparedOrdinaryImTurn;
      },
    },
    {
      name: 'extra symbol',
      mutate(turn: PreparedOrdinaryImTurn) {
        const copy = Object.create(
          Object.getPrototypeOf(turn),
          Object.getOwnPropertyDescriptors(turn),
        );
        Object.defineProperty(copy, Symbol('fabricated'), {
          value: true,
          configurable: false,
          writable: false,
        });
        return Object.freeze(copy) as PreparedOrdinaryImTurn;
      },
    },
    {
      name: 'content accessor',
      mutate(turn: PreparedOrdinaryImTurn) {
        const descriptors = Object.getOwnPropertyDescriptors(turn);
        descriptors.content = {
          get: () => turn.content,
          enumerable: true,
          configurable: false,
        };
        return Object.freeze(Object.create(
          Object.getPrototypeOf(turn),
          descriptors,
        )) as PreparedOrdinaryImTurn;
      },
    },
    {
      name: 'custom prototype',
      mutate(turn: PreparedOrdinaryImTurn) {
        return clonePrepared(turn, {}, { fabricated: true });
      },
    },
    {
      name: 'nested attachment path',
      mutate(turn: PreparedOrdinaryImTurn) {
        const attachment = Object.freeze({
          ...turn.attachments[0],
          path: '/tmp/private/image.png',
        });
        return clonePrepared(turn, { attachments: Object.freeze([attachment]) });
      },
    },
    {
      name: 'unfrozen nested sender',
      mutate(turn: PreparedOrdinaryImTurn) {
        return clonePrepared(turn, { sender: { ...turn.sender } });
      },
    },
  ])('fails closed before boundary execution for $name', ({ mutate }) => {
    const input = envelope();
    const normalized = normalizeOrdinaryImTurn(input);
    if (normalized.kind !== 'normalized') throw new Error('expected normalized turn');
    const realPreparation = createCurrentOrdinaryImTurnPreparationPort();
    const real = realPreparation.prepare(normalized.turn);
    if (real.kind !== 'prepared') throw new Error('expected prepared turn');
    const turnPreparation: CurrentOrdinaryImTurnPreparationPort = {
      prepare: () => ({ kind: 'prepared', turn: mutate(real.turn) }),
    };
    const activeSessions = new Map<string, DaemonSession>();
    const ds = daemonSession();
    activeSessions.set(activeSessionKey(ds), ds);
    const boundaryDriver = driver();
    const port = createCurrentOrdinaryIngressPort({
      ownerLarkAppId: OWNER,
      activeSessions,
      turnPreparation,
      boundaryDriver,
    });

    const result = port.begin({
      sessionId: ds.session.sessionId,
      turn: normalized.turn,
    });

    expect(result).toEqual({
      kind: 'unknown',
      message: 'ordinary IM turn preparation violated the exact compiler contract',
    });
    for (const method of Object.values(boundaryDriver)) {
      expect(method).not.toHaveBeenCalled();
    }
  });
});
