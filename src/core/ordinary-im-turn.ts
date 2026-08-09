/**
 * State-neutral ordinary IM transport contract and exact normalizer.
 *
 * This module is below both SessionRuntime and the Current Adapter. It accepts
 * transport business data only, rejects fields outside the exact allowlist,
 * and returns a detached, deeply frozen semantic value suitable for hashing.
 */

import { types as nodeUtilTypes } from 'node:util';

export interface OrdinaryImTurnRoute {
  readonly scope: 'thread' | 'chat';
  readonly canonicalAnchor: string;
  readonly chatId: string;
  readonly chatType: 'group' | 'p2p';
}

export interface OrdinaryImSenderDescriptor {
  readonly kind: 'human' | 'bot' | 'unknown';
  readonly openId?: string;
  readonly unionId?: string;
}

/** Provider resource identity only. Local download paths belong to a later effect. */
export interface OrdinaryImResourceDescriptor {
  readonly type: 'image' | 'file';
  readonly resourceKey: string;
  readonly sourceMessageKey?: string;
  readonly name: string;
}

export interface NormalizedOrdinaryImResourceDescriptor {
  readonly type: 'image' | 'file';
  readonly resourceKey: string;
  /** Always explicit after normalization, including an unfolded envelope source. */
  readonly sourceMessageKey: string;
  readonly name: string;
}

export interface OrdinaryImMentionDescriptor {
  readonly key: string;
  readonly name: string;
  readonly openId?: string;
  readonly userId?: string;
  readonly unionId?: string;
  readonly appId?: string;
}

export interface OrdinaryImWorkflowRewrite {
  readonly kind: 'workflowGrill';
  readonly goal: string;
}

export interface OrdinaryImSubstituteIdentity {
  readonly name?: string;
  readonly openId?: string;
  readonly userId?: string;
  readonly unionId?: string;
}

export interface OrdinaryImSubstituteSnapshot {
  readonly target: OrdinaryImSubstituteIdentity;
  readonly observedMention?: OrdinaryImSubstituteIdentity;
  readonly disclosure?: 'prefix' | 'none';
}

export interface NormalizedOrdinaryImSubstituteSnapshot {
  readonly target: OrdinaryImSubstituteIdentity;
  readonly observedMention?: OrdinaryImSubstituteIdentity;
  readonly disclosure: 'prefix' | 'none';
}

/**
 * Transport-captured VC routing snapshot for this exact Lark message. It is
 * still an untrusted candidate: the Current Adapter must revalidate every
 * owner, generation, membership, and receiver field against resolved state
 * before granting authority.
 */
export interface OrdinaryImVcTurnOrigin {
  readonly listenerAppId: string;
  readonly meetingId: string;
  readonly memberId: string;
  readonly memberEpoch: number;
  readonly agentAppId: string;
  readonly ownerBootId: string;
  readonly ownerEpoch: number;
  readonly membershipGeneration: number;
  readonly sinkOwnerGeneration: number;
  readonly receiverSessionId: string;
  readonly larkMessageId: string;
  readonly replyTargetSenderOpenId?: string;
}

/**
 * Message-scoped VC context. `imTurnOrigin` preserves the route-time snapshot
 * needed for queued turns; preservation alone never authorizes it.
 */
export interface OrdinaryImVcContext {
  readonly contextMayLag: boolean;
  readonly lifecycle?: 'active' | 'sealed';
  readonly imTurnOrigin?: OrdinaryImVcTurnOrigin;
}

/** State-neutral input already shaped by the IM transport Adapter. */
export interface OrdinaryImTransportEnvelope {
  readonly route: OrdinaryImTurnRoute;
  readonly source: 'lark.im';
  readonly messageKey: string;
  readonly content: string;
  readonly quotedMessageKey?: string;
  readonly replyRootMessageKey?: string;
  readonly sender: OrdinaryImSenderDescriptor;
  readonly mentions: readonly OrdinaryImMentionDescriptor[];
  readonly postParticipantMentions: readonly OrdinaryImMentionDescriptor[];
  readonly resources: readonly OrdinaryImResourceDescriptor[];
  readonly rewrite?: OrdinaryImWorkflowRewrite;
  readonly substitute?: OrdinaryImSubstituteSnapshot;
  readonly messageListener: boolean;
  readonly vc: OrdinaryImVcContext;
}

/** Exact semantic value consumed and hashed behind SessionRuntime admission. */
export interface NormalizedOrdinaryImTurn {
  readonly route: OrdinaryImTurnRoute;
  readonly source: 'lark.im';
  readonly messageKey: string;
  readonly content: string;
  readonly quotedMessageKey?: string;
  readonly replyRootMessageKey?: string;
  readonly sender: OrdinaryImSenderDescriptor;
  readonly mentions: readonly OrdinaryImMentionDescriptor[];
  readonly postParticipantMentions: readonly OrdinaryImMentionDescriptor[];
  readonly resources: readonly NormalizedOrdinaryImResourceDescriptor[];
  readonly rewrite?: OrdinaryImWorkflowRewrite;
  readonly substitute?: NormalizedOrdinaryImSubstituteSnapshot;
  readonly messageListener: boolean;
  readonly vc: OrdinaryImVcContext;
}

export type OrdinaryImTurnNormalizationResult =
  | { readonly kind: 'normalized'; readonly turn: NormalizedOrdinaryImTurn }
  | {
      readonly kind: 'rejected';
      readonly reason: 'invalidTransportIdentity' | 'invalidEnvelope' | 'unsafeField';
      readonly message: string;
    };

type RejectionReason = Exclude<OrdinaryImTurnNormalizationResult, { kind: 'normalized' }>['reason'];

class NormalizationError extends Error {
  constructor(
    readonly reason: RejectionReason,
    message: string,
  ) {
    super(message);
  }
}

function requireRecord(
  value: unknown,
  label: string,
  requiredFields: readonly string[],
  optionalFields: readonly string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new NormalizationError('invalidEnvelope', `${label} must be a plain object`);
  }
  if (nodeUtilTypes.isProxy(value)) {
    throw new NormalizationError('invalidEnvelope', `${label} must not be a Proxy`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new NormalizationError('invalidEnvelope', `${label} must be a plain object`);
  }
  const allowed = new Set([...requiredFields, ...optionalFields]);
  const values = Object.create(null) as Record<string, unknown>;
  const present = new Set<string>();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      throw new NormalizationError('unsafeField', `${label} contains unsupported symbol field`);
    }
    if (!allowed.has(key)) {
      throw new NormalizationError('unsafeField', `${label} contains unsupported field: ${key}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
      throw new NormalizationError('invalidEnvelope', `${label}.${key} must be detached data`);
    }
    present.add(key);
    values[key] = descriptor.value;
  }
  for (const key of requiredFields) {
    if (!present.has(key)) {
      throw new NormalizationError('invalidEnvelope', `${label}.${key} must be detached data`);
    }
  }
  for (const key of optionalFields) {
    if (!present.has(key) && key in value) {
      throw new NormalizationError('invalidEnvelope', `${label}.${key} must be detached data`);
    }
  }
  return values;
}

function exactIdentity(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new NormalizationError(
      'invalidTransportIdentity',
      `${label} must be an exact non-empty transport identity`,
    );
  }
  return value;
}

function optionalIdentity(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : exactIdentity(value, label);
}

function optionalNoopIdentity(value: unknown, label: string): string | undefined {
  return value === undefined || value === '' ? undefined : exactIdentity(value, label);
}

function normalizeQuotedMessageKey(
  value: unknown,
  route: OrdinaryImTurnRoute,
  messageKey: string,
): string | undefined {
  const quotedMessageKey = optionalNoopIdentity(value, 'ordinary IM quotedMessageKey');
  if (quotedMessageKey === undefined
      || quotedMessageKey === messageKey
      || (route.scope === 'thread' && quotedMessageKey === route.canonicalAnchor)) {
    return undefined;
  }
  return quotedMessageKey;
}

function text(value: unknown, label: string, { empty = true } = {}): string {
  if (typeof value !== 'string' || (!empty && value.length === 0)) {
    throw new NormalizationError('invalidEnvelope', `${label} must be a string`);
  }
  return value;
}

function normalizeRoute(value: unknown): OrdinaryImTurnRoute {
  const route = requireRecord(value, 'ordinary IM route', [
    'scope',
    'canonicalAnchor',
    'chatId',
    'chatType',
  ]);
  if (route.scope !== 'thread' && route.scope !== 'chat') {
    throw new NormalizationError('invalidEnvelope', 'ordinary IM route.scope is invalid');
  }
  if (route.chatType !== 'group' && route.chatType !== 'p2p') {
    throw new NormalizationError('invalidEnvelope', 'ordinary IM route.chatType is invalid');
  }
  return Object.freeze({
    scope: route.scope,
    canonicalAnchor: exactIdentity(route.canonicalAnchor, 'ordinary IM route.canonicalAnchor'),
    chatId: exactIdentity(route.chatId, 'ordinary IM route.chatId'),
    chatType: route.chatType,
  });
}

function normalizeSender(value: unknown): OrdinaryImSenderDescriptor {
  const sender = requireRecord(
    value,
    'ordinary IM sender descriptor',
    ['kind'],
    ['openId', 'unionId'],
  );
  if (sender.kind !== 'human' && sender.kind !== 'bot' && sender.kind !== 'unknown') {
    throw new NormalizationError('invalidEnvelope', 'ordinary IM sender descriptor.kind is invalid');
  }
  return Object.freeze({
    kind: sender.kind,
    ...(sender.openId === undefined
      ? {}
      : { openId: optionalIdentity(sender.openId, 'ordinary IM sender descriptor.openId') }),
    ...(sender.unionId === undefined
      ? {}
      : { unionId: optionalIdentity(sender.unionId, 'ordinary IM sender descriptor.unionId') }),
  });
}

function normalizeResource(
  value: unknown,
  envelopeMessageKey: string,
): NormalizedOrdinaryImResourceDescriptor {
  const resource = requireRecord(
    value,
    'ordinary IM resource descriptor',
    ['type', 'resourceKey', 'name'],
    ['sourceMessageKey'],
  );
  if (resource.type !== 'image' && resource.type !== 'file') {
    throw new NormalizationError('invalidEnvelope', 'ordinary IM resource descriptor.type is invalid');
  }
  return Object.freeze({
    type: resource.type,
    resourceKey: exactIdentity(
      resource.resourceKey,
      'ordinary IM resource descriptor.resourceKey',
    ),
    sourceMessageKey: resource.sourceMessageKey === undefined
      ? envelopeMessageKey
      : exactIdentity(
          resource.sourceMessageKey,
          'ordinary IM resource descriptor.sourceMessageKey',
        ),
    name: text(resource.name, 'ordinary IM resource descriptor.name', { empty: false }),
  });
}

function normalizeMention(value: unknown): OrdinaryImMentionDescriptor {
  const mention = requireRecord(
    value,
    'ordinary IM mention descriptor',
    ['key', 'name'],
    ['openId', 'userId', 'unionId', 'appId'],
  );
  return Object.freeze({
    key: exactIdentity(mention.key, 'ordinary IM mention descriptor.key'),
    name: text(mention.name, 'ordinary IM mention descriptor.name'),
    ...(mention.openId === undefined
      ? {}
      : { openId: optionalIdentity(mention.openId, 'ordinary IM mention descriptor.openId') }),
    ...(mention.userId === undefined
      ? {}
      : { userId: optionalIdentity(mention.userId, 'ordinary IM mention descriptor.userId') }),
    ...(mention.unionId === undefined
      ? {}
      : { unionId: optionalIdentity(mention.unionId, 'ordinary IM mention descriptor.unionId') }),
    ...(mention.appId === undefined
      ? {}
      : { appId: optionalIdentity(mention.appId, 'ordinary IM mention descriptor.appId') }),
  });
}

function normalizeRewrite(value: unknown): OrdinaryImWorkflowRewrite {
  const rewrite = requireRecord(value, 'ordinary IM rewrite', ['kind', 'goal']);
  if (rewrite.kind !== 'workflowGrill') {
    throw new NormalizationError('invalidEnvelope', 'ordinary IM rewrite.kind is invalid');
  }
  return Object.freeze({
    kind: 'workflowGrill',
    goal: text(rewrite.goal, 'ordinary IM rewrite.goal', { empty: false }),
  });
}

function normalizeSubstituteIdentity(
  value: unknown,
  label: string,
): OrdinaryImSubstituteIdentity {
  const identity = requireRecord(value, label, [], ['name', 'openId', 'userId', 'unionId']);
  return Object.freeze({
    ...(identity.name === undefined ? {} : { name: text(identity.name, `${label}.name`) }),
    ...(identity.openId === undefined
      ? {}
      : { openId: optionalIdentity(identity.openId, `${label}.openId`) }),
    ...(identity.userId === undefined
      ? {}
      : { userId: optionalIdentity(identity.userId, `${label}.userId`) }),
    ...(identity.unionId === undefined
      ? {}
      : { unionId: optionalIdentity(identity.unionId, `${label}.unionId`) }),
  });
}

function normalizeSubstitute(value: unknown): NormalizedOrdinaryImSubstituteSnapshot {
  const substitute = requireRecord(
    value,
    'ordinary IM substitute snapshot',
    ['target'],
    ['observedMention', 'disclosure'],
  );
  if (substitute.disclosure !== undefined
      && substitute.disclosure !== 'prefix'
      && substitute.disclosure !== 'none') {
    throw new NormalizationError(
      'invalidEnvelope',
      'ordinary IM substitute snapshot.disclosure is invalid',
    );
  }
  return Object.freeze({
    target: normalizeSubstituteIdentity(
      substitute.target,
      'ordinary IM substitute target identity',
    ),
    ...(substitute.observedMention === undefined
      ? {}
      : {
          observedMention: normalizeSubstituteIdentity(
            substitute.observedMention,
            'ordinary IM substitute observed identity',
          ),
        }),
    disclosure: substitute.disclosure ?? 'prefix',
  });
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new NormalizationError(
      'invalidEnvelope',
      `${label} must be a positive safe integer`,
    );
  }
  return value as number;
}

function normalizeVcTurnOrigin(
  value: unknown,
  envelopeMessageKey: string,
): OrdinaryImVcTurnOrigin {
  const origin = requireRecord(
    value,
    'ordinary IM VC turn origin',
    [
      'listenerAppId',
      'meetingId',
      'memberId',
      'memberEpoch',
      'agentAppId',
      'ownerBootId',
      'ownerEpoch',
      'membershipGeneration',
      'sinkOwnerGeneration',
      'receiverSessionId',
      'larkMessageId',
    ],
    ['replyTargetSenderOpenId'],
  );
  const larkMessageId = exactIdentity(
    origin.larkMessageId,
    'ordinary IM VC turn origin.larkMessageId',
  );
  if (larkMessageId !== envelopeMessageKey) {
    throw new NormalizationError(
      'invalidTransportIdentity',
      'ordinary IM VC turn origin.larkMessageId must equal ordinary IM messageKey',
    );
  }
  return Object.freeze({
    listenerAppId: exactIdentity(
      origin.listenerAppId,
      'ordinary IM VC turn origin.listenerAppId',
    ),
    meetingId: exactIdentity(origin.meetingId, 'ordinary IM VC turn origin.meetingId'),
    memberId: exactIdentity(origin.memberId, 'ordinary IM VC turn origin.memberId'),
    memberEpoch: positiveSafeInteger(
      origin.memberEpoch,
      'ordinary IM VC turn origin.memberEpoch',
    ),
    agentAppId: exactIdentity(origin.agentAppId, 'ordinary IM VC turn origin.agentAppId'),
    ownerBootId: exactIdentity(
      origin.ownerBootId,
      'ordinary IM VC turn origin.ownerBootId',
    ),
    ownerEpoch: positiveSafeInteger(
      origin.ownerEpoch,
      'ordinary IM VC turn origin.ownerEpoch',
    ),
    membershipGeneration: positiveSafeInteger(
      origin.membershipGeneration,
      'ordinary IM VC turn origin.membershipGeneration',
    ),
    sinkOwnerGeneration: positiveSafeInteger(
      origin.sinkOwnerGeneration,
      'ordinary IM VC turn origin.sinkOwnerGeneration',
    ),
    receiverSessionId: exactIdentity(
      origin.receiverSessionId,
      'ordinary IM VC turn origin.receiverSessionId',
    ),
    larkMessageId,
    ...(origin.replyTargetSenderOpenId === undefined
      ? {}
      : {
          replyTargetSenderOpenId: optionalIdentity(
            origin.replyTargetSenderOpenId,
            'ordinary IM VC turn origin.replyTargetSenderOpenId',
          ),
        }),
  });
}

function normalizeVc(value: unknown, envelopeMessageKey: string): OrdinaryImVcContext {
  const vc = requireRecord(
    value,
    'ordinary IM VC context',
    ['contextMayLag'],
    ['lifecycle', 'imTurnOrigin'],
  );
  if (typeof vc.contextMayLag !== 'boolean') {
    throw new NormalizationError(
      'invalidEnvelope',
      'ordinary IM VC context.contextMayLag must be a boolean',
    );
  }
  if (vc.lifecycle !== undefined && vc.lifecycle !== 'active' && vc.lifecycle !== 'sealed') {
    throw new NormalizationError('invalidEnvelope', 'ordinary IM VC context.lifecycle is invalid');
  }
  return Object.freeze({
    contextMayLag: vc.contextMayLag,
    ...(vc.lifecycle === 'sealed' ? { lifecycle: 'sealed' as const } : {}),
    ...(vc.imTurnOrigin === undefined
      ? {}
      : { imTurnOrigin: normalizeVcTurnOrigin(vc.imTurnOrigin, envelopeMessageKey) }),
  });
}

function normalizeList<T>(
  value: unknown,
  label: string,
  normalize: (item: unknown) => T,
): readonly T[] {
  if (nodeUtilTypes.isProxy(value)
      || !Array.isArray(value)
      || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new NormalizationError('invalidEnvelope', `${label} must be an exact Array`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      throw new NormalizationError('unsafeField', `${label} contains unsupported symbol field`);
    }
    if (key === 'length') {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!lengthDescriptor
          || !('value' in lengthDescriptor)
          || lengthDescriptor.enumerable
          || lengthDescriptor.configurable) {
        throw new NormalizationError('invalidEnvelope', `${label}.length is not an exact Array descriptor`);
      }
      continue;
    }
    const index = Number(key);
    const canonicalIndex = Number.isSafeInteger(index)
      && index >= 0
      && index < value.length
      && String(index) === key;
    if (!canonicalIndex) {
      throw new NormalizationError('unsafeField', `${label} contains unsupported field: ${key}`);
    }
  }
  const copy: T[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      throw new NormalizationError('invalidEnvelope', `${label}[${index}] is missing`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
      throw new NormalizationError('invalidEnvelope', `${label}[${index}] must be detached data`);
    }
    copy.push(normalize(descriptor.value));
  }
  return Object.freeze(copy);
}

/** Normalize one raw envelope without consulting Session or Current state. */
export function normalizeOrdinaryImTurn(
  input: OrdinaryImTransportEnvelope,
): OrdinaryImTurnNormalizationResult {
  try {
    const envelope = requireRecord(input, 'ordinary IM transport envelope', [
      'route',
      'source',
      'messageKey',
      'content',
      'sender',
      'mentions',
      'postParticipantMentions',
      'resources',
      'messageListener',
      'vc',
    ], [
      'quotedMessageKey',
      'replyRootMessageKey',
      'rewrite',
      'substitute',
    ]);
    if (envelope.source !== 'lark.im') {
      throw new NormalizationError('invalidEnvelope', 'ordinary IM source is invalid');
    }
    if (typeof envelope.messageListener !== 'boolean') {
      throw new NormalizationError(
        'invalidEnvelope',
        'ordinary IM messageListener must be a boolean',
      );
    }

    const messageKey = exactIdentity(envelope.messageKey, 'ordinary IM messageKey');
    const route = normalizeRoute(envelope.route);
    const quotedMessageKey = normalizeQuotedMessageKey(
      envelope.quotedMessageKey,
      route,
      messageKey,
    );
    const suppliedReplyRootMessageKey = optionalNoopIdentity(
      envelope.replyRootMessageKey,
      'ordinary IM replyRootMessageKey',
    );
    const replyRootMessageKey = route.scope === 'chat'
      ? suppliedReplyRootMessageKey
      : undefined;
    const turn: NormalizedOrdinaryImTurn = Object.freeze({
      route,
      source: 'lark.im',
      messageKey,
      content: text(envelope.content, 'ordinary IM content'),
      ...(quotedMessageKey === undefined ? {} : { quotedMessageKey }),
      ...(replyRootMessageKey === undefined ? {} : { replyRootMessageKey }),
      sender: normalizeSender(envelope.sender),
      mentions: normalizeList(envelope.mentions, 'ordinary IM mentions', normalizeMention),
      postParticipantMentions: normalizeList(
        envelope.postParticipantMentions,
        'ordinary IM post participant mentions',
        normalizeMention,
      ),
      resources: normalizeList(
        envelope.resources,
        'ordinary IM resources',
        item => normalizeResource(item, messageKey),
      ),
      ...(envelope.rewrite === undefined ? {} : { rewrite: normalizeRewrite(envelope.rewrite) }),
      ...(envelope.substitute === undefined
        ? {}
        : { substitute: normalizeSubstitute(envelope.substitute) }),
      messageListener: envelope.messageListener,
      vc: normalizeVc(envelope.vc, messageKey),
    });
    return Object.freeze({ kind: 'normalized', turn });
  } catch (error) {
    if (error instanceof NormalizationError) {
      return Object.freeze({
        kind: 'rejected',
        reason: error.reason,
        message: error.message,
      });
    }
    return Object.freeze({
      kind: 'rejected',
      reason: 'invalidEnvelope',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
