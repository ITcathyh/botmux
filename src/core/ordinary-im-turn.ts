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
  readonly name?: string;
}

/** Provider resource identity only. Local download paths belong to a later effect. */
export interface OrdinaryImAttachmentDescriptor {
  readonly type: 'image' | 'file';
  readonly resourceKey: string;
  readonly sourceMessageKey?: string;
  readonly name: string;
}

export interface NormalizedOrdinaryImAttachmentDescriptor {
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
  readonly kind: 'human' | 'bot' | 'unknown';
}

/** State-neutral input already shaped by the IM transport Adapter. */
export interface OrdinaryImTransportEnvelope {
  readonly route: OrdinaryImTurnRoute;
  readonly source: 'lark.im';
  readonly messageKey: string;
  readonly content: string;
  readonly sender: OrdinaryImSenderDescriptor;
  readonly attachments: readonly OrdinaryImAttachmentDescriptor[];
  readonly mentions: readonly OrdinaryImMentionDescriptor[];
}

/** Exact semantic value consumed and hashed behind SessionRuntime admission. */
export interface NormalizedOrdinaryImTurn {
  readonly route: OrdinaryImTurnRoute;
  readonly source: 'lark.im';
  readonly messageKey: string;
  readonly content: string;
  readonly sender: OrdinaryImSenderDescriptor;
  readonly attachments: readonly NormalizedOrdinaryImAttachmentDescriptor[];
  readonly mentions: readonly OrdinaryImMentionDescriptor[];
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
    ['openId', 'name'],
  );
  if (sender.kind !== 'human' && sender.kind !== 'bot' && sender.kind !== 'unknown') {
    throw new NormalizationError('invalidEnvelope', 'ordinary IM sender descriptor.kind is invalid');
  }
  return Object.freeze({
    kind: sender.kind,
    ...(sender.openId === undefined
      ? {}
      : { openId: optionalIdentity(sender.openId, 'ordinary IM sender descriptor.openId') }),
    ...(sender.name === undefined ? {} : { name: text(sender.name, 'ordinary IM sender descriptor.name') }),
  });
}

function normalizeAttachment(
  value: unknown,
  envelopeMessageKey: string,
): NormalizedOrdinaryImAttachmentDescriptor {
  const attachment = requireRecord(
    value,
    'ordinary IM attachment descriptor',
    ['type', 'resourceKey', 'name'],
    ['sourceMessageKey'],
  );
  if (attachment.type !== 'image' && attachment.type !== 'file') {
    throw new NormalizationError('invalidEnvelope', 'ordinary IM attachment descriptor.type is invalid');
  }
  return Object.freeze({
    type: attachment.type,
    resourceKey: exactIdentity(
      attachment.resourceKey,
      'ordinary IM attachment descriptor.resourceKey',
    ),
    sourceMessageKey: attachment.sourceMessageKey === undefined
      ? envelopeMessageKey
      : exactIdentity(
          attachment.sourceMessageKey,
          'ordinary IM attachment descriptor.sourceMessageKey',
        ),
    name: text(attachment.name, 'ordinary IM attachment descriptor.name', { empty: false }),
  });
}

function normalizeMention(value: unknown): OrdinaryImMentionDescriptor {
  const mention = requireRecord(
    value,
    'ordinary IM mention descriptor',
    ['key', 'name', 'kind'],
    ['openId'],
  );
  if (mention.kind !== 'human' && mention.kind !== 'bot' && mention.kind !== 'unknown') {
    throw new NormalizationError('invalidEnvelope', 'ordinary IM mention descriptor.kind is invalid');
  }
  return Object.freeze({
    key: exactIdentity(mention.key, 'ordinary IM mention descriptor.key'),
    name: text(mention.name, 'ordinary IM mention descriptor.name', { empty: false }),
    ...(mention.openId === undefined
      ? {}
      : { openId: optionalIdentity(mention.openId, 'ordinary IM mention descriptor.openId') }),
    kind: mention.kind,
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
      'attachments',
      'mentions',
    ]);
    if (envelope.source !== 'lark.im') {
      throw new NormalizationError('invalidEnvelope', 'ordinary IM source is invalid');
    }

    const messageKey = exactIdentity(envelope.messageKey, 'ordinary IM messageKey');
    const turn: NormalizedOrdinaryImTurn = Object.freeze({
      route: normalizeRoute(envelope.route),
      source: 'lark.im',
      messageKey,
      content: text(envelope.content, 'ordinary IM content'),
      sender: normalizeSender(envelope.sender),
      attachments: normalizeList(
        envelope.attachments,
        'ordinary IM attachments',
        item => normalizeAttachment(item, messageKey),
      ),
      mentions: normalizeList(envelope.mentions, 'ordinary IM mentions', normalizeMention),
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
