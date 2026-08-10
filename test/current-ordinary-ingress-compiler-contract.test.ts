import { describe, expect, it, vi } from 'vitest';

import {
  createCurrentOrdinaryImTurnPreparationPort,
  type CurrentOrdinaryImTurnPreparationPort,
  type PreparedOrdinaryImTurn,
} from '../src/core/current-ordinary-im-turn.js';
import {
  createCurrentOrdinaryIngressPort,
  type CurrentOrdinaryIngressCommandAdapter,
  type CurrentOrdinaryIngressExternalEffectExecutor,
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
    quotedMessageKey: 'om_quoted',
    sender: { kind: 'human', openId: 'ou_sender', unionId: 'on_sender' },
    resources: [{
      type: 'image',
      resourceKey: 'img_resource',
      name: 'image.png',
    }],
    mentions: [{
      key: '@_user',
      name: 'Mention',
      openId: 'ou_mention',
      userId: 'u_mention',
      unionId: 'on_mention',
      appId: 'cli_mention',
    }],
    postParticipantMentions: [{ key: '@_post_at_1', name: 'Peer', appId: 'cli_peer' }],
    rewrite: { kind: 'workflowGrill', goal: 'exact goal' },
    substitute: {
      target: { name: 'Target', openId: 'ou_target' },
      observedMention: { name: 'Observed', userId: 'u_target' },
      disclosure: 'prefix',
    },
    foldedForwardContext: false,
    messageListener: {
      prompt: 'Investigate the alert.',
      messageText: 'disk pressure',
      msgType: 'interactive',
      senderType: 'bot',
      replyCardTitle: 'Production alert',
      workingDir: '/repos/alert-service',
    },
    vc: {
      contextMayLag: true,
      lifecycle: 'sealed',
      imTurnOrigin: {
        listenerAppId: 'cli_listener',
        meetingId: 'meeting_1',
        memberId: 'minutes',
        memberEpoch: 3,
        agentAppId: OWNER,
        ownerBootId: 'boot_1',
        ownerEpoch: 5,
        membershipGeneration: 7,
        sinkOwnerGeneration: 11,
        receiverSessionId: 'session-1',
        larkMessageId: 'om_compiler_contract',
        replyTargetSenderOpenId: 'ou_reply_target',
      },
    },
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

function adapters(): {
  externalEffects: CurrentOrdinaryIngressExternalEffectExecutor;
  commands: CurrentOrdinaryIngressCommandAdapter;
} {
  return {
    externalEffects: {
      execute: vi.fn(async () => ({ kind: 'materialized' as const })),
    },
    commands: {
      apply: vi.fn(() => ({ kind: 'accepted' as const })),
    },
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
      name: 'nested resource path',
      mutate(turn: PreparedOrdinaryImTurn) {
        const resource = Object.freeze({
          ...turn.resources[0],
          path: '/tmp/private/image.png',
        });
        return clonePrepared(turn, { resources: Object.freeze([resource]) });
      },
    },
    {
      name: 'unfrozen nested sender',
      mutate(turn: PreparedOrdinaryImTurn) {
        return clonePrepared(turn, { sender: { ...turn.sender } });
      },
    },
    {
      name: 'changed frozen VC business fact',
      mutate(turn: PreparedOrdinaryImTurn) {
        return clonePrepared(turn, {
          vc: Object.freeze({ ...turn.vc, contextMayLag: false }),
        });
      },
    },
    {
      name: 'changed frozen VC routing snapshot',
      mutate(turn: PreparedOrdinaryImTurn) {
        const origin = turn.vc.imTurnOrigin;
        if (!origin) throw new Error('expected VC turn origin');
        return clonePrepared(turn, {
          vc: Object.freeze({
            ...turn.vc,
            imTurnOrigin: Object.freeze({ ...origin, ownerEpoch: origin.ownerEpoch + 1 }),
          }),
        });
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
    const currentAdapters = adapters();
    const port = createCurrentOrdinaryIngressPort({
      ownerLarkAppId: OWNER,
      activeSessions,
      turnPreparation,
      ...currentAdapters,
    });

    const result = port.begin({
      sessionId: ds.session.sessionId,
      turn: normalized.turn,
    });

    expect(result).toEqual({
      kind: 'unknown',
      message: 'ordinary IM turn preparation violated the exact compiler contract',
    });
    expect(currentAdapters.externalEffects.execute).not.toHaveBeenCalled();
    expect(currentAdapters.commands.apply).not.toHaveBeenCalled();
  });
});
