/**
 * Pure Current compiler for an ordinary IM transport turn.
 *
 * This is preparation-only scaffolding and is not wired to production. A future
 * staged Current ingress Adapter may call it only after `begin` has accepted the
 * resolved route/Session lane. A prepared value is not a Runtime command or an
 * authority claim: it contains transport business facts only and cannot open a
 * public prepare-now/submit-later gap.
 *
 * Session/DaemonSession, worker handles, generations, local attachment paths,
 * and ordering claims are intentionally absent from the Interface. Preparation
 * performs no I/O, has no await, and returns a detached, deeply frozen value.
 */

const preparedOrdinaryImTurnBrand: unique symbol = Symbol('PreparedOrdinaryImTurn');

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

export interface PreparedOrdinaryImAttachmentDescriptor {
  readonly type: 'image' | 'file';
  readonly resourceKey: string;
  /** Always explicit after preparation, including an unfolded envelope source. */
  readonly sourceMessageKey: string;
  readonly name: string;
}

export interface OrdinaryImMentionDescriptor {
  readonly key: string;
  readonly name: string;
  readonly openId?: string;
  readonly kind: 'human' | 'bot' | 'unknown';
}

/** State-neutral input already normalized by the Lark transport Adapter. */
export interface OrdinaryImTransportEnvelope {
  readonly route: OrdinaryImTurnRoute;
  readonly source: 'lark.im';
  readonly messageKey: string;
  readonly content: string;
  readonly sender: OrdinaryImSenderDescriptor;
  readonly attachments: readonly OrdinaryImAttachmentDescriptor[];
  readonly mentions: readonly OrdinaryImMentionDescriptor[];
}

/**
 * Future staged-ingress input, factory-minted and immutable at runtime.
 * The brand records nominal compiler provenance only; it grants no authority,
 * ordering position, claim, or right to mutate a Session.
 */
export interface PreparedOrdinaryImTurn {
  readonly [preparedOrdinaryImTurnBrand]: true;
  readonly route: OrdinaryImTurnRoute;
  readonly source: 'lark.im';
  readonly messageKey: string;
  readonly content: string;
  readonly sender: OrdinaryImSenderDescriptor;
  readonly attachments: readonly PreparedOrdinaryImAttachmentDescriptor[];
  readonly mentions: readonly OrdinaryImMentionDescriptor[];
}

export type OrdinaryImTurnPrepareResult =
  | { readonly kind: 'prepared'; readonly turn: PreparedOrdinaryImTurn }
  | {
      readonly kind: 'rejected';
      readonly reason: 'invalidTransportIdentity' | 'invalidEnvelope' | 'unsafeField';
      readonly message: string;
    };

/** Preparation-only compiler seam intended for a future staged Current ingress Adapter. */
export interface CurrentOrdinaryImTurnPreparationPort {
  prepare(input: OrdinaryImTransportEnvelope): OrdinaryImTurnPrepareResult;
}

type RejectionReason = Exclude<OrdinaryImTurnPrepareResult, { kind: 'prepared' }>['reason'];

class PreparationValidationError extends Error {
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
  allowedFields: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PreparationValidationError('invalidEnvelope', `${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new PreparationValidationError('invalidEnvelope', `${label} must be a plain object`);
  }
  const allowed = new Set(allowedFields);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      throw new PreparationValidationError('unsafeField', `${label} contains unsupported symbol field`);
    }
    if (!allowed.has(key)) {
      throw new PreparationValidationError('unsafeField', `${label} contains unsupported field: ${key}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
      throw new PreparationValidationError('invalidEnvelope', `${label}.${key} must be detached data`);
    }
  }
  return value as Record<string, unknown>;
}

function exactIdentity(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new PreparationValidationError(
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
    throw new PreparationValidationError('invalidEnvelope', `${label} must be a string`);
  }
  return value;
}

function compileRoute(value: unknown): OrdinaryImTurnRoute {
  const route = requireRecord(value, 'ordinary IM route', [
    'scope',
    'canonicalAnchor',
    'chatId',
    'chatType',
  ]);
  if (route.scope !== 'thread' && route.scope !== 'chat') {
    throw new PreparationValidationError('invalidEnvelope', 'ordinary IM route.scope is invalid');
  }
  if (route.chatType !== 'group' && route.chatType !== 'p2p') {
    throw new PreparationValidationError('invalidEnvelope', 'ordinary IM route.chatType is invalid');
  }
  return Object.freeze({
    scope: route.scope,
    canonicalAnchor: exactIdentity(route.canonicalAnchor, 'ordinary IM route.canonicalAnchor'),
    chatId: exactIdentity(route.chatId, 'ordinary IM route.chatId'),
    chatType: route.chatType,
  });
}

function compileSender(value: unknown): OrdinaryImSenderDescriptor {
  const sender = requireRecord(value, 'ordinary IM sender descriptor', ['kind', 'openId', 'name']);
  if (sender.kind !== 'human' && sender.kind !== 'bot' && sender.kind !== 'unknown') {
    throw new PreparationValidationError('invalidEnvelope', 'ordinary IM sender descriptor.kind is invalid');
  }
  return Object.freeze({
    kind: sender.kind,
    ...(sender.openId === undefined
      ? {}
      : { openId: optionalIdentity(sender.openId, 'ordinary IM sender descriptor.openId') }),
    ...(sender.name === undefined ? {} : { name: text(sender.name, 'ordinary IM sender descriptor.name') }),
  });
}

function compileAttachment(
  value: unknown,
  envelopeMessageKey: string,
): PreparedOrdinaryImAttachmentDescriptor {
  const attachment = requireRecord(value, 'ordinary IM attachment descriptor', [
    'type',
    'resourceKey',
    'sourceMessageKey',
    'name',
  ]);
  if (attachment.type !== 'image' && attachment.type !== 'file') {
    throw new PreparationValidationError('invalidEnvelope', 'ordinary IM attachment descriptor.type is invalid');
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

function compileMention(value: unknown): OrdinaryImMentionDescriptor {
  const mention = requireRecord(value, 'ordinary IM mention descriptor', [
    'key',
    'name',
    'openId',
    'kind',
  ]);
  if (mention.kind !== 'human' && mention.kind !== 'bot' && mention.kind !== 'unknown') {
    throw new PreparationValidationError('invalidEnvelope', 'ordinary IM mention descriptor.kind is invalid');
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

function compileList<T>(
  value: unknown,
  label: string,
  compile: (item: unknown) => T,
): readonly T[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new PreparationValidationError('invalidEnvelope', `${label} must be an exact Array`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      throw new PreparationValidationError('unsafeField', `${label} contains unsupported symbol field`);
    }
    if (key === 'length') {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!lengthDescriptor
          || !('value' in lengthDescriptor)
          || lengthDescriptor.enumerable
          || lengthDescriptor.configurable) {
        throw new PreparationValidationError('invalidEnvelope', `${label}.length is not an exact Array descriptor`);
      }
      continue;
    }
    const index = Number(key);
    const canonicalIndex = Number.isSafeInteger(index)
      && index >= 0
      && index < value.length
      && String(index) === key;
    if (!canonicalIndex) {
      throw new PreparationValidationError('unsafeField', `${label} contains unsupported field: ${key}`);
    }
  }
  const copy: T[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      throw new PreparationValidationError('invalidEnvelope', `${label}[${index}] is missing`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
      throw new PreparationValidationError('invalidEnvelope', `${label}[${index}] must be detached data`);
    }
    copy.push(compile(descriptor.value));
  }
  return Object.freeze(copy);
}

/** Create the state-free preparation-only compiler. */
export function createCurrentOrdinaryImTurnPreparationPort(): CurrentOrdinaryImTurnPreparationPort {
  return Object.freeze({
    prepare(input: OrdinaryImTransportEnvelope): OrdinaryImTurnPrepareResult {
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
          throw new PreparationValidationError('invalidEnvelope', 'ordinary IM source is invalid');
        }

        const messageKey = exactIdentity(envelope.messageKey, 'ordinary IM messageKey');
        const turn = {
          route: compileRoute(envelope.route),
          source: 'lark.im' as const,
          messageKey,
          content: text(envelope.content, 'ordinary IM content'),
          sender: compileSender(envelope.sender),
          attachments: compileList(
            envelope.attachments,
            'ordinary IM attachments',
            item => compileAttachment(item, messageKey),
          ),
          mentions: compileList(envelope.mentions, 'ordinary IM mentions', compileMention),
        } as PreparedOrdinaryImTurn;
        Object.defineProperty(turn, preparedOrdinaryImTurnBrand, {
          value: true,
          enumerable: false,
          configurable: false,
          writable: false,
        });
        Object.freeze(turn);
        return Object.freeze({ kind: 'prepared', turn });
      } catch (error) {
        if (error instanceof PreparationValidationError) {
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
    },
  });
}
