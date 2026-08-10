import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCurrentOrdinaryIngressMetadataModule,
  type CurrentOrdinaryIngressMetadataBinding,
  type CurrentOrdinaryIngressMetadataInput,
} from '../src/core/current-ordinary-ingress-metadata.js';
import {
  normalizeOrdinaryImTurn,
  type NormalizedOrdinaryImTurn,
  type OrdinaryImTransportEnvelope,
} from '../src/core/ordinary-im-turn.js';
import type { DaemonSession } from '../src/core/types.js';
import type { VcMeetingImTurnOrigin } from '../src/types.js';

vi.mock('../src/services/session-store.js', () => ({
  updateSession: vi.fn(),
}));

import * as sessionStore from '../src/services/session-store.js';

const APP = 'app_metadata_owner';
const CHAT = 'oc_metadata_chat';
const ROOT = 'om_metadata_root';
const SESSION = 'session-metadata-owner';
const AT_MS = Date.parse('2026-08-10T01:02:03.000Z');
const AT_ISO = '2026-08-10T01:02:03.000Z';

const LIVE_VC_ORIGIN: VcMeetingImTurnOrigin = {
  listenerAppId: 'app_listener',
  meetingId: 'meeting_exact',
  memberId: 'member_exact',
  memberEpoch: 4,
  agentAppId: APP,
  ownerBootId: 'boot_exact',
  ownerEpoch: 8,
  membershipGeneration: 12,
  sinkOwnerGeneration: 16,
  receiverSessionId: SESSION,
  larkMessageId: 'om_metadata_turn',
  replyTargetSenderOpenId: 'ou_sender',
};

function dsFor(scope: 'thread' | 'chat' = 'chat', vc = false): DaemonSession {
  return {
    session: {
      sessionId: SESSION,
      chatId: CHAT,
      rootMessageId: ROOT,
      scope,
      chatType: 'group',
      title: 'metadata owner',
      status: 'active',
      createdAt: '2026-08-10T00:00:00.000Z',
      ...(vc
        ? {
            vcMeetingReceiver: {
              listenerAppId: LIVE_VC_ORIGIN.listenerAppId,
              meetingId: LIVE_VC_ORIGIN.meetingId,
              memberId: LIVE_VC_ORIGIN.memberId,
              memberEpoch: LIVE_VC_ORIGIN.memberEpoch,
            },
          }
        : {}),
    },
    worker: { killed: false } as DaemonSession['worker'],
    workerPort: null,
    workerToken: null,
    larkAppId: APP,
    chatId: CHAT,
    chatType: 'group',
    scope,
    spawnedAt: 1,
    cliVersion: 'test',
    lastMessageAt: 1,
    hasHistory: true,
  } as DaemonSession;
}

function normalizedTurn(args: {
  scope?: 'thread' | 'chat';
  canonicalAnchor?: string;
  vcOrigin?: VcMeetingImTurnOrigin;
} = {}): NormalizedOrdinaryImTurn {
  const scope = args.scope ?? 'chat';
  const envelope: OrdinaryImTransportEnvelope = {
    route: {
      scope,
      canonicalAnchor: args.canonicalAnchor ?? (scope === 'chat' ? CHAT : ROOT),
      chatId: CHAT,
      chatType: 'group',
    },
    source: 'lark.im',
    messageKey: 'om_metadata_turn',
    content: 'update exact turn metadata',
    replyRootMessageKey: 'om_reply_root',
    sender: { kind: 'human', openId: 'ou_sender' },
    mentions: [
      { key: '@_self', name: 'Self', appId: APP },
      { key: '@_peer', name: 'Peer Bot', openId: 'ou_peer_bot' },
      { key: '@_unresolved', name: 'Unresolved', userId: 'on_unresolved' },
    ],
    postParticipantMentions: [
      { key: '@_post', name: 'Post Participant', openId: 'ou_post_human' },
    ],
    resources: [],
    substitute: {
      target: { name: 'Reviewer', openId: 'ou_reviewer' },
      disclosure: 'prefix',
    },
    foldedForwardContext: false,
    vc: {
      contextMayLag: false,
      ...(args.vcOrigin ? { imTurnOrigin: args.vcOrigin } : {}),
    },
  };
  const normalized = normalizeOrdinaryImTurn(envelope);
  if (normalized.kind !== 'normalized') throw new Error(normalized.message);
  return normalized.turn;
}

function bindingFor(ds: DaemonSession, turn: NormalizedOrdinaryImTurn): CurrentOrdinaryIngressMetadataBinding {
  return {
    ownerLarkAppId: ds.larkAppId,
    sessionId: ds.session.sessionId,
    route: turn.route,
  };
}

function inputFor(
  ds: DaemonSession,
  turn: NormalizedOrdinaryImTurn,
  overrides: Partial<CurrentOrdinaryIngressMetadataInput> = {},
): CurrentOrdinaryIngressMetadataInput {
  return {
    binding: bindingFor(ds, turn),
    turn,
    activityAtMs: AT_MS,
    replyMode: 'quote',
    receivedReaction: {
      messageKey: turn.messageKey,
      reactionId: 'reaction_received_exact',
    },
    ...overrides,
  };
}

function fullVcValidator(origin: VcMeetingImTurnOrigin): boolean {
  return JSON.stringify(origin) === JSON.stringify(LIVE_VC_ORIGIN);
}

function moduleFor(validateVcOrigin = vi.fn(fullVcValidator)) {
  return {
    module: createCurrentOrdinaryIngressMetadataModule({
      ownerLarkAppId: APP,
      selfBotOpenId: 'ou_self_bot',
      selfBotAppId: APP,
      isPeerBot: (openId: string) => openId === 'ou_peer_bot',
      validateVcOrigin,
    }),
    validateVcOrigin,
  };
}

beforeEach(() => {
  vi.mocked(sessionStore.updateSession).mockReset();
});

describe('Current ordinary ingress authoritative metadata', () => {
  it('commits activity, quote/caller provenance, exact reply window, and optional received-reaction evidence synchronously', () => {
    const ds = dsFor('chat');
    const turn = normalizedTurn();
    const { module, validateVcOrigin } = moduleFor();

    const result = module.apply(ds, inputFor(ds, turn));

    expect(result).toEqual({
      kind: 'committed',
      sessionId: SESSION,
      turnId: 'om_metadata_turn',
    });
    expect(result).not.toHaveProperty('then');
    expect(validateVcOrigin).not.toHaveBeenCalled();
    expect(ds.lastMessageAt).toBe(AT_MS);
    expect(ds.session).toMatchObject({
      lastMessageAt: AT_ISO,
      lastInboundPreview: {
        messageKey: 'om_metadata_turn',
        content: 'update exact turn metadata',
        receivedAtMs: AT_MS,
      },
      quoteTargetId: 'om_metadata_turn',
      quoteTargetSenderOpenId: 'ou_sender',
      quoteTargetSenderIsBot: false,
      lastCallerOpenId: 'ou_sender',
      turnReplyContexts: {
        om_metadata_turn: {
          target: { mode: 'quote', rootMessageId: 'om_reply_root' },
          quoteTargetId: 'om_metadata_turn',
          replyTargetSenderOpenId: 'ou_sender',
          replyTargetSenderIsBot: false,
        },
      },
      replyTargets: {
        om_metadata_turn: {
          rootMessageId: 'om_reply_root',
          updatedAt: AT_ISO,
          quoteOnly: true,
          substitute: true,
          senderOpenId: 'ou_sender',
          participants: [
            { openId: 'ou_sender', isBot: false },
            { openId: 'ou_peer_bot', name: 'Peer Bot', isBot: true },
            { openId: 'ou_post_human', name: 'Post Participant' },
          ],
          participantsIncomplete: true,
        },
      },
      currentReplyTarget: {
        rootMessageId: 'om_reply_root',
        turnId: 'om_metadata_turn',
        updatedAt: AT_ISO,
        quoteOnly: true,
        substitute: true,
      },
    });
    expect(ds.pendingAckReactions).toEqual([
      { messageId: 'om_metadata_turn', reactionId: 'reaction_received_exact' },
    ]);
    expect(sessionStore.updateSession).toHaveBeenCalledTimes(1);
    expect(sessionStore.updateSession).toHaveBeenCalledWith(ds.session);
  });

  it('keeps one stable inbound preview observation when the exact turn is retried', () => {
    const ds = dsFor('chat');
    const turn = normalizedTurn();
    const { module } = moduleFor();

    expect(module.apply(ds, inputFor(ds, turn))).toMatchObject({ kind: 'committed' });
    const first = ds.session.lastInboundPreview;
    expect(first).toEqual({
      messageKey: turn.messageKey,
      content: turn.content,
      receivedAtMs: AT_MS,
    });

    expect(module.apply(ds, inputFor(ds, turn, {
      activityAtMs: AT_MS + 5_000,
    }))).toMatchObject({ kind: 'committed' });
    expect(ds.session.lastInboundPreview).toBe(first);
  });

  it.each([
    {
      name: 'owner',
      change(binding: CurrentOrdinaryIngressMetadataBinding) {
        return { ...binding, ownerLarkAppId: 'app_wrong_owner' };
      },
    },
    {
      name: 'session',
      change(binding: CurrentOrdinaryIngressMetadataBinding) {
        return { ...binding, sessionId: 'session_wrong_owner' };
      },
    },
    {
      name: 'route',
      change(binding: CurrentOrdinaryIngressMetadataBinding) {
        return { ...binding, route: { ...binding.route, canonicalAnchor: 'oc_wrong_anchor' } };
      },
    },
  ])('fails closed before mutation when the exact $name binding mismatches', ({ change }) => {
    const ds = dsFor('chat');
    const turn = normalizedTurn();
    const before = structuredClone(ds);
    const { module, validateVcOrigin } = moduleFor();
    const input = inputFor(ds, turn, { binding: change(bindingFor(ds, turn)) });

    expect(module.apply(ds, input)).toMatchObject({
      kind: 'rejected',
      reason: 'bindingMismatch',
    });
    expect(ds).toEqual(before);
    expect(validateVcOrigin).not.toHaveBeenCalled();
    expect(sessionStore.updateSession).not.toHaveBeenCalled();
  });

  it('fails closed when binding and turn agree with each other but not with the live route owner', () => {
    const ds = dsFor('chat');
    const turn = normalizedTurn({ canonicalAnchor: 'oc_stale_route_owner' });
    const before = structuredClone(ds);
    const { module } = moduleFor();

    expect(module.apply(ds, inputFor(ds, turn))).toMatchObject({
      kind: 'rejected',
      reason: 'bindingMismatch',
    });
    expect(ds).toEqual(before);
    expect(sessionStore.updateSession).not.toHaveBeenCalled();
  });

  it('remembers a VC origin only after the injected full validator proves every fence', () => {
    const ds = dsFor('chat', true);
    const turn = normalizedTurn({
      canonicalAnchor: `vc-receiver:${SESSION}`,
      vcOrigin: LIVE_VC_ORIGIN,
    });
    const before = structuredClone(ds);
    const validateVcOrigin = vi.fn((origin: VcMeetingImTurnOrigin) => {
      // The full validator must run before activity, quote, reply-window, VC,
      // reaction, or SessionStore mutation.
      expect(ds).toEqual(before);
      expect(sessionStore.updateSession).not.toHaveBeenCalled();
      return fullVcValidator(origin);
    });
    const { module } = moduleFor(validateVcOrigin);

    expect(module.apply(ds, inputFor(ds, turn))).toMatchObject({ kind: 'committed' });
    expect(validateVcOrigin).toHaveBeenCalledTimes(1);
    expect(validateVcOrigin).toHaveBeenCalledWith(
      LIVE_VC_ORIGIN,
      {
        receiverSessionId: SESSION,
        agentAppId: APP,
        targetChatId: CHAT,
      },
    );
    expect(ds.vcMeetingImTurnOrigin).toEqual(LIVE_VC_ORIGIN);
    expect(ds.vcMeetingImTurnOrigin).not.toBe(turn.vc.imTurnOrigin);
    expect(ds.session.vcMeetingImTurnOrigins).toEqual({
      om_metadata_turn: LIVE_VC_ORIGIN,
    });
  });

  it.each([
    ['receiverSessionId', 'session_other'],
    ['agentAppId', 'app_other'],
    ['listenerAppId', 'app_listener_other'],
    ['meetingId', 'meeting_other'],
    ['memberId', 'member_other'],
    ['memberEpoch', 5],
    ['ownerBootId', 'boot_other'],
    ['ownerEpoch', 9],
    ['membershipGeneration', 13],
    ['sinkOwnerGeneration', 17],
    ['larkMessageId', 'om_other_turn'],
  ] as const)('fails closed before any mutation for a VC %s fence mismatch', (field, value) => {
    const ds = dsFor('chat', true);
    const origin = { ...LIVE_VC_ORIGIN, [field]: value } as VcMeetingImTurnOrigin;
    const turn = field === 'larkMessageId'
      ? {
          ...normalizedTurn({
            canonicalAnchor: `vc-receiver:${SESSION}`,
            vcOrigin: LIVE_VC_ORIGIN,
          }),
          vc: { contextMayLag: false, imTurnOrigin: origin },
        } as NormalizedOrdinaryImTurn
      : normalizedTurn({
          canonicalAnchor: `vc-receiver:${SESSION}`,
          vcOrigin: origin,
        });
    const before = structuredClone(ds);
    const { module } = moduleFor();

    expect(module.apply(ds, inputFor(ds, turn))).toMatchObject({
      kind: 'rejected',
      reason: 'vcOriginUnproven',
    });
    expect(ds).toEqual(before);
    expect(sessionStore.updateSession).not.toHaveBeenCalled();
  });

  it('returns typed unknown and keeps the candidate mirror when the SessionStore response is lost', () => {
    const ds = dsFor('chat');
    ds.pendingAckReactions = [{ messageId: 'om_prior', reactionId: 'reaction_prior' }];
    const turn = normalizedTurn();
    const { module } = moduleFor();
    vi.mocked(sessionStore.updateSession).mockImplementationOnce(() => {
      throw new Error('store response lost after publish');
    });

    expect(module.apply(ds, inputFor(ds, turn))).toEqual({
      kind: 'unknown',
      message: 'ordinary ingress metadata persistence outcome is unknown: store response lost after publish',
    });
    expect(ds.session.quoteTargetId).toBe(turn.messageKey);
    expect(ds.session.lastInboundPreview).toEqual({
      messageKey: turn.messageKey,
      content: turn.content,
      receivedAtMs: AT_MS,
    });
    expect(ds.session.replyTargets?.[turn.messageKey]).toMatchObject({
      rootMessageId: turn.replyRootMessageKey,
      senderOpenId: turn.sender.openId,
    });
    expect(ds.pendingAckReactions).toEqual([
      { messageId: 'om_prior', reactionId: 'reaction_prior' },
      { messageId: turn.messageKey, reactionId: 'reaction_received_exact' },
    ]);
    expect(sessionStore.updateSession).toHaveBeenCalledTimes(1);
  });

  it('returns typed unknown without mutation when the full VC authority oracle is unreadable', () => {
    const ds = dsFor('chat', true);
    const turn = normalizedTurn({
      canonicalAnchor: `vc-receiver:${SESSION}`,
      vcOrigin: LIVE_VC_ORIGIN,
    });
    const before = structuredClone(ds);
    const { module } = moduleFor(() => {
      throw new Error('owner projection unreadable');
    });

    expect(module.apply(ds, inputFor(ds, turn))).toEqual({
      kind: 'unknown',
      message: 'ordinary ingress VC authority could not be validated: owner projection unreadable',
    });
    expect(ds).toEqual(before);
    expect(sessionStore.updateSession).not.toHaveBeenCalled();
  });
});
