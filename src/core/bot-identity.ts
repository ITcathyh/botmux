import { createHash } from 'node:crypto';

/** Stable owner identity derived from the bot's external address. */
declare const botIdBrand: unique symbol;
export type BotId = string & { readonly [botIdBrand]: true };

/** Stable actor address exposed by projections; transport bindings stay private. */
export interface ActorRef {
  readonly botId: BotId;
  readonly entityKind: 'session';
  readonly entityId: string;
}

const BOT_ID_PATTERN = /^bot_[A-Za-z0-9_-]{8,128}$/;

export function parseBotId(value: unknown): BotId {
  if (typeof value !== 'string' || !BOT_ID_PATTERN.test(value)) {
    throw new Error('invalid opaque BotId');
  }
  return value as BotId;
}

export function sessionActorRef(botId: BotId, sessionId: string): ActorRef {
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.includes('\0')) {
    throw new Error('invalid session actor entity ID');
  }
  return Object.freeze({ botId, entityKind: 'session', entityId: sessionId });
}

/** External address a bot is reachable at; the identity input, never the identity itself. */
export type BotExternalAddress =
  | { readonly kind: 'lark'; readonly larkAppId: string }
  | { readonly kind: 'coreOnly'; readonly launchId: string };

/**
 * BotId is a pure function of the bot's external address: no registry, no
 * allocation state, no migration or promotion ceremony. The hash keeps the id
 * opaque-shaped and kind-separated (a `lark` app id and a `coreOnly` launch id
 * with the same string derive different identities), and the same address
 * always derives the same identity — removing a bot and re-adding it later
 * reconnects to everything keyed by its identity instead of orphaning it.
 * Display name, secrets and launch knobs never shift the identity. If a
 * rebind-to-a-new-address semantic is ever needed, introduce an explicit
 * exception mapping at that point rather than an allocation registry here.
 */
export function deriveBotId(address: BotExternalAddress): BotId {
  const id = address.kind === 'lark' ? address.larkAppId : address.launchId;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('bot external address has no id');
  }
  const digest = createHash('sha256').update(`${address.kind}\0${id}`).digest('hex');
  return `bot_${digest.slice(0, 32)}` as BotId;
}

export function deriveBotIdForConfig(
  config: { readonly apiOnly?: boolean; readonly larkAppId: string },
): BotId {
  return deriveBotId(config.apiOnly === true
    ? { kind: 'coreOnly', launchId: config.larkAppId }
    : { kind: 'lark', larkAppId: config.larkAppId });
}
