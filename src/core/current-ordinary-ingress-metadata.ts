import type { VcMeetingImTurnOrigin } from '../types.js';
import * as sessionStore from '../services/session-store.js';
import type {
  NormalizedOrdinaryImTurn,
  OrdinaryImTurnRoute,
  OrdinaryImVcTurnOrigin,
} from './ordinary-im-turn.js';
import {
  beginReplyTargetTurn,
  buildTurnParticipantsFrom,
} from './reply-target.js';
import { activeSessionAnchorId, type DaemonSession } from './types.js';
import { rememberVcMeetingImTurnOrigin } from './vc-meeting-im-turn-origin.js';

export interface CurrentOrdinaryIngressMetadataBinding {
  readonly ownerLarkAppId: string;
  readonly sessionId: string;
  readonly route: OrdinaryImTurnRoute;
}

export interface CurrentOrdinaryIngressReceivedReaction {
  readonly messageKey: string;
  readonly reactionId: string;
}

export interface CurrentOrdinaryIngressMetadataInput {
  readonly binding: CurrentOrdinaryIngressMetadataBinding;
  readonly turn: NormalizedOrdinaryImTurn;
  readonly activityAtMs: number;
  readonly replyMode: 'thread' | 'quote';
  /** Evidence from a separately completed Lark effect; this Module never awaits it. */
  readonly receivedReaction?: CurrentOrdinaryIngressReceivedReaction;
}

export type CurrentOrdinaryIngressMetadataResult =
  | {
      readonly kind: 'committed';
      readonly sessionId: string;
      readonly turnId: string;
    }
  | {
      readonly kind: 'rejected';
      readonly reason: 'bindingMismatch' | 'vcOriginUnproven' | 'reactionEvidenceMismatch';
      readonly message: string;
    }
  | { readonly kind: 'unknown'; readonly message: string };

export interface CurrentOrdinaryIngressMetadataModule {
  apply(
    ds: DaemonSession,
    input: CurrentOrdinaryIngressMetadataInput,
  ): CurrentOrdinaryIngressMetadataResult;
}

export interface CurrentOrdinaryIngressMetadataOptions {
  readonly ownerLarkAppId: string;
  readonly selfBotOpenId?: string;
  readonly selfBotAppId?: string;
  readonly isPeerBot: (openId: string) => boolean;
  /** Full Current VC authority validation, including every durable generation fence. */
  readonly validateVcOrigin: (
    origin: VcMeetingImTurnOrigin,
    expected: {
      readonly receiverSessionId: string;
      readonly agentAppId: string;
      readonly targetChatId: string;
    },
  ) => boolean;
}

function sameRoute(left: OrdinaryImTurnRoute, right: OrdinaryImTurnRoute): boolean {
  return left.scope === right.scope
    && left.canonicalAnchor === right.canonicalAnchor
    && left.chatId === right.chatId
    && left.chatType === right.chatType;
}

function currentRoute(ds: DaemonSession): OrdinaryImTurnRoute {
  return {
    scope: ds.scope,
    canonicalAnchor: activeSessionAnchorId(ds),
    chatId: ds.chatId,
    chatType: ds.chatType,
  };
}

function asVcOrigin(origin: OrdinaryImVcTurnOrigin): VcMeetingImTurnOrigin {
  return {
    listenerAppId: origin.listenerAppId,
    meetingId: origin.meetingId,
    memberId: origin.memberId,
    memberEpoch: origin.memberEpoch,
    agentAppId: origin.agentAppId,
    ownerBootId: origin.ownerBootId,
    ownerEpoch: origin.ownerEpoch,
    membershipGeneration: origin.membershipGeneration,
    sinkOwnerGeneration: origin.sinkOwnerGeneration,
    receiverSessionId: origin.receiverSessionId,
    larkMessageId: origin.larkMessageId,
    ...(origin.replyTargetSenderOpenId
      ? { replyTargetSenderOpenId: origin.replyTargetSenderOpenId }
      : {}),
  };
}

function bindingRejection(message: string): CurrentOrdinaryIngressMetadataResult {
  return { kind: 'rejected', reason: 'bindingMismatch', message };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Current named Module for the short, authoritative per-turn metadata commit.
 * It is synchronous by construction: Lark reactions, identity lookup, worker
 * delivery, and UI publication happen outside this interface.
 */
export function createCurrentOrdinaryIngressMetadataModule(
  options: CurrentOrdinaryIngressMetadataOptions,
): CurrentOrdinaryIngressMetadataModule {
  return {
    apply(ds, input) {
      const { binding, turn } = input;
      if (binding.ownerLarkAppId !== options.ownerLarkAppId
        || ds.larkAppId !== options.ownerLarkAppId) {
        return bindingRejection('ordinary ingress metadata owner binding does not match Current owner');
      }
      if (binding.sessionId !== ds.session.sessionId || ds.session.status !== 'active') {
        return bindingRejection('ordinary ingress metadata Session binding is stale');
      }
      if (!sameRoute(binding.route, turn.route) || !sameRoute(binding.route, currentRoute(ds))) {
        return bindingRejection('ordinary ingress metadata route binding is stale');
      }
      if (!Number.isFinite(input.activityAtMs)
        || Number.isNaN(new Date(input.activityAtMs).getTime())) {
        return bindingRejection('ordinary ingress metadata activity timestamp is invalid');
      }
      if (input.receivedReaction
        && (input.receivedReaction.messageKey !== turn.messageKey
          || input.receivedReaction.reactionId.length === 0)) {
        return {
          kind: 'rejected',
          reason: 'reactionEvidenceMismatch',
          message: 'ordinary ingress received-reaction evidence does not name the exact turn',
        };
      }

      const candidateOrigin = turn.vc.imTurnOrigin;
      const receiver = ds.session.vcMeetingReceiver;
      let provenOrigin: VcMeetingImTurnOrigin | undefined;
      if (receiver || candidateOrigin) {
        if (!receiver || !candidateOrigin) {
          return {
            kind: 'rejected',
            reason: 'vcOriginUnproven',
            message: 'ordinary ingress VC origin is missing or targets a non-receiver Session',
          };
        }
        const origin = asVcOrigin(candidateOrigin);
        if (origin.receiverSessionId !== ds.session.sessionId
          || origin.agentAppId !== ds.larkAppId
          || origin.listenerAppId !== receiver.listenerAppId
          || origin.meetingId !== receiver.meetingId
          || origin.memberId !== receiver.memberId
          || origin.memberEpoch !== receiver.memberEpoch) {
          return {
            kind: 'rejected',
            reason: 'vcOriginUnproven',
            message: 'ordinary ingress VC receiver or app binding is stale',
          };
        }
        try {
          if (!options.validateVcOrigin(origin, {
            receiverSessionId: ds.session.sessionId,
            agentAppId: ds.larkAppId,
            targetChatId: ds.chatId,
          })) {
            return {
              kind: 'rejected',
              reason: 'vcOriginUnproven',
              message: 'ordinary ingress VC authority generation is stale',
            };
          }
        } catch (error) {
          return {
            kind: 'unknown',
            message: `ordinary ingress VC authority could not be validated: ${message(error)}`,
          };
        }
        provenOrigin = origin;
      }

      const atIso = new Date(input.activityAtMs).toISOString();
      try {
        ds.lastMessageAt = input.activityAtMs;
        ds.session.lastMessageAt = atIso;
        if (ds.session.lastInboundPreview?.messageKey !== turn.messageKey) {
          ds.session.lastInboundPreview = {
            messageKey: turn.messageKey,
            content: turn.content,
            receivedAtMs: input.activityAtMs,
          };
        }
        ds.session.quoteTargetId = turn.messageKey;
        ds.session.quoteTargetSenderOpenId = turn.sender.openId;
        ds.session.quoteTargetSenderIsBot = turn.sender.kind === 'bot';
        if (turn.sender.openId) ds.session.lastCallerOpenId = turn.sender.openId;

        const participantWindow = buildTurnParticipantsFrom(
          {
            openId: turn.sender.openId,
            isBot: turn.sender.kind === 'unknown' ? undefined : turn.sender.kind === 'bot',
          },
          [...turn.mentions, ...turn.postParticipantMentions].map(mention => ({ ...mention })),
          options.selfBotOpenId,
          options.isPeerBot,
          options.selfBotAppId,
        );
        beginReplyTargetTurn(
          ds,
          turn.replyRootMessageKey,
          turn.messageKey,
          atIso,
          {
            quoteOnly: input.replyMode === 'quote',
            substitute: turn.substitute !== undefined,
            senderOpenId: turn.sender.openId,
            participants: participantWindow.participants,
            participantsIncomplete: participantWindow.incomplete,
          },
        );

        if (provenOrigin) {
          ds.vcMeetingImTurnOrigin = structuredClone(provenOrigin);
          rememberVcMeetingImTurnOrigin(ds.session, provenOrigin);
        }
        if (input.receivedReaction
          && !(ds.pendingAckReactions ?? []).some(
            evidence => evidence.messageId === input.receivedReaction!.messageKey,
          )) {
          (ds.pendingAckReactions ??= []).push({
            messageId: input.receivedReaction.messageKey,
            reactionId: input.receivedReaction.reactionId,
          });
        }

        sessionStore.updateSession(ds.session);
        return {
          kind: 'committed',
          sessionId: ds.session.sessionId,
          turnId: turn.messageKey,
        };
      } catch (error) {
        // The Current JSON publisher cannot distinguish a pre-publish failure
        // from a lost response after the complete row was replaced. Keep the
        // candidate mirror and quarantine the attempt as unknown; restoring
        // the prior in-memory row could let a later whole-row save erase an
        // already-published exact turn.
        return {
          kind: 'unknown',
          message: `ordinary ingress metadata persistence outcome is unknown: ${message(error)}`,
        };
      }
    },
  };
}
