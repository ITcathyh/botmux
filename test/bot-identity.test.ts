import { afterEach, describe, expect, it } from 'vitest';

import {
  __testOnly_resetBotRegistry,
  registerBot,
  requireBotId,
  type BotConfig,
} from '../src/bot-registry.js';
import {
  deriveBotId,
  deriveBotIdForConfig,
  parseBotId,
  sessionActorRef,
} from '../src/core/bot-identity.js';

describe('derived stable Bot identity', () => {
  afterEach(() => __testOnly_resetBotRegistry());

  it('derives a deterministic, pattern-valid, kind-separated BotId from the external address', () => {
    const larkId = deriveBotId({ kind: 'lark', larkAppId: 'cli_stable' });
    expect(larkId).toBe(deriveBotId({ kind: 'lark', larkAppId: 'cli_stable' }));
    expect(parseBotId(larkId)).toBe(larkId);
    // The same string under a different address kind must not collide.
    expect(deriveBotId({ kind: 'coreOnly', launchId: 'cli_stable' })).not.toBe(larkId);
    expect(deriveBotId({ kind: 'lark', larkAppId: 'cli_other' })).not.toBe(larkId);
    expect(() => deriveBotId({ kind: 'lark', larkAppId: '' })).toThrow(/no id/);
  });

  it('keeps identity independent of display name, secrets and launch knobs', () => {
    const base: BotConfig = { larkAppId: 'cli_knobs', larkAppSecret: 'secret', cliId: 'codex-app' };
    const rotated: BotConfig = {
      ...base,
      larkAppSecret: 'rotated-secret',
      botName: 'renamed',
      model: 'other-model',
    } as BotConfig;
    expect(deriveBotIdForConfig(rotated)).toBe(deriveBotIdForConfig(base));
    // apiOnly flips the address kind, so it must shift the identity.
    expect(deriveBotIdForConfig({ ...base, apiOnly: true } as BotConfig))
      .not.toBe(deriveBotIdForConfig(base));
  });

  it('registerBot always binds the derived identity, for transport and core-only bots alike', () => {
    const larkCfg: BotConfig = { larkAppId: 'cli_reg', larkAppSecret: 'secret', cliId: 'codex-app' };
    const coreCfg: BotConfig = { larkAppId: 'local_reg', larkAppSecret: '', apiOnly: true, cliId: 'codex-app' };
    expect(registerBot(larkCfg).botId).toBe(deriveBotIdForConfig(larkCfg));
    expect(registerBot(coreCfg).botId).toBe(deriveBotId({ kind: 'coreOnly', launchId: 'local_reg' }));
    expect(requireBotId('cli_reg')).toBe(deriveBotIdForConfig(larkCfg));

    // A restart (fresh registry, same config) re-derives the same identity.
    const before = requireBotId('local_reg');
    __testOnly_resetBotRegistry();
    registerBot(coreCfg);
    expect(requireBotId('local_reg')).toBe(before);
  });

  it('composes actor refs from the derived identity', () => {
    const botId = deriveBotId({ kind: 'lark', larkAppId: 'cli_actor' });
    expect(sessionActorRef(botId, 'sess-1')).toEqual({
      botId,
      entityKind: 'session',
      entityId: 'sess-1',
    });
  });
});
