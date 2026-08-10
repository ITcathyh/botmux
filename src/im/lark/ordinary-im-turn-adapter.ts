import type {
  LarkMention,
  LarkMessage,
  SubstituteTrigger,
  VcMeetingImTurnOrigin,
} from '../../types.js';
import {
  normalizeOrdinaryImTurn,
  type NormalizedOrdinaryImTurn,
  type OrdinaryImMentionDescriptor,
  type OrdinaryImMessageListenerSnapshot,
  type OrdinaryImSenderDescriptor,
  type OrdinaryImSubstituteIdentity,
  type OrdinaryImTransportEnvelope,
  type OrdinaryImTurnRoute,
  type OrdinaryImVcTurnOrigin,
} from '../../core/ordinary-im-turn.js';
import type { MessageResource } from './message-parser.js';
import type { MessageListenerMatch } from '../../services/message-listener.js';

export type LarkOrdinaryImMessage = Readonly<Pick<
  LarkMessage,
  | 'messageId'
  | 'parentId'
  | 'senderId'
  | 'senderUnionId'
  | 'senderType'
  | 'content'
  | 'mentions'
>>;

/** Detached Lark facts captured before Session policy or external effects. */
export interface LarkOrdinaryImTurnInput {
  readonly route: OrdinaryImTurnRoute;
  readonly message: LarkOrdinaryImMessage;
  /** Exact chat-scope reply target resolved by the Lark router. */
  readonly replyRootMessageKey?: string;
  readonly resources: readonly MessageResource[];
  readonly senderPeerBotRecognized: boolean;
  readonly postParticipantMentions: readonly LarkMention[];
  readonly workflowGoal?: string;
  readonly substituteTrigger?: SubstituteTrigger;
  /** The current message already contains a detached forwarded-context fold. */
  readonly foldedForwardContext: boolean;
  readonly messageListener?: MessageListenerMatch;
  readonly vcMeetingContextMayLag: boolean;
  readonly vcMeetingContextLifecycle?: 'active' | 'sealed';
  readonly vcMeetingImTurnOrigin?: VcMeetingImTurnOrigin;
}

function senderKind(
  senderType: string,
  peerBotRecognized: boolean,
): OrdinaryImSenderDescriptor['kind'] {
  if (peerBotRecognized || senderType === 'app' || senderType === 'bot') return 'bot';
  if (senderType === 'user') return 'human';
  return 'unknown';
}

function mentionDescriptor(mention: LarkMention): OrdinaryImMentionDescriptor {
  return {
    key: mention.key,
    name: mention.name,
    ...(mention.openId === undefined ? {} : { openId: mention.openId }),
    ...(mention.userId === undefined ? {} : { userId: mention.userId }),
    ...(mention.unionId === undefined ? {} : { unionId: mention.unionId }),
    ...(mention.appId === undefined ? {} : { appId: mention.appId }),
  };
}

function substituteIdentity(
  identity: SubstituteTrigger['target'],
): OrdinaryImSubstituteIdentity {
  return {
    ...(identity.name === undefined ? {} : { name: identity.name }),
    ...(identity.openId === undefined ? {} : { openId: identity.openId }),
    ...(identity.userId === undefined ? {} : { userId: identity.userId }),
    ...(identity.unionId === undefined ? {} : { unionId: identity.unionId }),
  };
}

function vcTurnOrigin(origin: VcMeetingImTurnOrigin): OrdinaryImVcTurnOrigin {
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
    ...(origin.replyTargetSenderOpenId === undefined
      ? {}
      : { replyTargetSenderOpenId: origin.replyTargetSenderOpenId }),
  };
}

function messageListenerSnapshot(
  match: MessageListenerMatch,
): OrdinaryImMessageListenerSnapshot {
  return {
    prompt: match.prompt,
    messageText: match.messageText,
    msgType: match.msgType,
    senderType: match.senderType,
    ...(match.name === undefined ? {} : { name: match.name }),
    ...(match.replyCardTitle === undefined
      ? {}
      : { replyCardTitle: match.replyCardTitle }),
    ...(match.workingDir === undefined ? {} : { workingDir: match.workingDir }),
    ...(match.messageTitle === undefined ? {} : { messageTitle: match.messageTitle }),
    ...(match.senderOpenId === undefined ? {} : { senderOpenId: match.senderOpenId }),
    ...(match.senderName === undefined ? {} : { senderName: match.senderName }),
  };
}

/** Compile detached provider facts into the neutral, canonical turn contract. */
export function compileLarkOrdinaryImTurn(
  input: LarkOrdinaryImTurnInput,
): NormalizedOrdinaryImTurn {
  const envelope: OrdinaryImTransportEnvelope = {
    route: input.route,
    source: 'lark.im',
    messageKey: input.message.messageId,
    content: input.message.content,
    ...(input.message.parentId === undefined
      ? {}
      : { quotedMessageKey: input.message.parentId }),
    ...(input.replyRootMessageKey === undefined
      ? {}
      : { replyRootMessageKey: input.replyRootMessageKey }),
    sender: {
      kind: senderKind(input.message.senderType, input.senderPeerBotRecognized),
      ...(input.message.senderId === '' ? {} : { openId: input.message.senderId }),
      ...(input.message.senderUnionId === undefined
        ? {}
        : { unionId: input.message.senderUnionId }),
    },
    mentions: (input.message.mentions ?? []).map(mentionDescriptor),
    postParticipantMentions: input.postParticipantMentions.map(mentionDescriptor),
    resources: input.resources.map(resource => ({
      type: resource.type,
      resourceKey: resource.key,
      ...(resource.messageId === undefined
        ? {}
        : { sourceMessageKey: resource.messageId }),
      name: resource.name,
    })),
    ...(input.workflowGoal === undefined
      ? {}
      : { rewrite: { kind: 'workflowGrill', goal: input.workflowGoal } }),
    ...(input.substituteTrigger === undefined
      ? {}
      : {
          substitute: {
            target: substituteIdentity(input.substituteTrigger.target),
            ...(input.substituteTrigger.observedMention === undefined
              ? {}
              : {
                  observedMention: substituteIdentity(
                    input.substituteTrigger.observedMention,
                  ),
                }),
            ...(input.substituteTrigger.disclosure === undefined
              ? {}
              : { disclosure: input.substituteTrigger.disclosure }),
          },
        }),
    foldedForwardContext: input.foldedForwardContext,
    ...(input.messageListener === undefined
      ? {}
      : { messageListener: messageListenerSnapshot(input.messageListener) }),
    vc: {
      contextMayLag: input.vcMeetingContextMayLag,
      ...(input.vcMeetingContextLifecycle === undefined
        ? {}
        : { lifecycle: input.vcMeetingContextLifecycle }),
      ...(input.vcMeetingImTurnOrigin === undefined
        ? {}
        : { imTurnOrigin: vcTurnOrigin(input.vcMeetingImTurnOrigin) }),
    },
  };
  const normalized = normalizeOrdinaryImTurn(envelope);
  if (normalized.kind === 'rejected') {
    throw new TypeError(`invalid Lark ordinary IM turn: ${normalized.message}`);
  }
  return normalized.turn;
}
