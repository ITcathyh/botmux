/** Stable, opaque owner identity allocated by the local identity control plane. */
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
