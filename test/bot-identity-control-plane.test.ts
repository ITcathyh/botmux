import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createBotIdentityControlPlane,
  type BotIdentityPlan,
} from '../src/services/bot-identity-control-plane.js';

const configBytes = (larkAppIds: readonly string[]): string => `${JSON.stringify(
  larkAppIds.map(larkAppId => ({ larkAppId, larkAppSecret: `secret-${larkAppId}` })),
  null,
  2,
)}\n`;

describe('BotIdentityControlPlane', () => {
  let roots: string[];

  beforeEach(() => { roots = []; });
  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  function fixture(
    botIds: string[],
    operationIds: string[],
    afterPhase?: Parameters<typeof createBotIdentityControlPlane>[0]['afterPhase'],
  ) {
    const root = mkdtempSync(join(tmpdir(), 'botmux-bot-identity-'));
    roots.push(root);
    const configPath = join(root, 'bots.json');
    writeFileSync(configPath, configBytes(['cli_same']));
    return {
      root,
      configPath,
      control: createBotIdentityControlPlane({
        dataDir: root,
        configPath,
        allocateBotId: () => botIds.shift()!,
        allocateOperationId: () => operationIds.shift()!,
        now: () => '2026-08-11T00:00:00.000Z',
        afterPhase,
      }),
    };
  }

  it('allocates opaque identity inside each state root without deriving it from Lark App ID', () => {
    const left = fixture(['bot_random_left'], ['op_left']);
    const right = fixture(['bot_random_right'], ['op_right']);

    const leftPlan: BotIdentityPlan = left.control.report();
    const rightPlan: BotIdentityPlan = right.control.report();

    expect(leftPlan.targetRegistry.bindings[0]).toMatchObject({
      botId: 'bot_random_left',
      status: 'active',
      address: { kind: 'lark', larkAppId: 'cli_same' },
    });
    expect(rightPlan.targetRegistry.bindings[0]?.botId).toBe('bot_random_right');
    expect(leftPlan.targetRegistry.bindings[0]?.botId).not.toBe(
      rightPlan.targetRegistry.bindings[0]?.botId,
    );
    expect(existsSync(join(left.root, 'bot-identities.json'))).toBe(false);
  });

  it('isolates the same core-only launch slug by resolved state root', () => {
    const coreOnly = `${JSON.stringify([{
      larkAppId: 'local_riff',
      apiOnly: true,
    }], null, 2)}\n`;
    const makeCore = (botId: string, operationId: string) => {
      const root = mkdtempSync(join(tmpdir(), 'botmux-core-identity-'));
      roots.push(root);
      return {
        root,
        control: createBotIdentityControlPlane({
          dataDir: root,
          readOnlyConfigBytes: () => coreOnly,
          allocateBotId: () => botId,
          allocateOperationId: () => operationId,
        }),
      };
    };
    const left = makeCore('bot_core_left', 'op_core_left');
    const right = makeCore('bot_core_right', 'op_core_right');

    expect(left.control.report().targetRegistry.bindings[0]).toMatchObject({
      botId: 'bot_core_left',
      address: { kind: 'coreOnly', launchId: 'local_riff' },
    });
    expect(right.control.report().targetRegistry.bindings[0]?.botId).toBe('bot_core_right');
    left.control.apply('op_core_left');
    right.control.apply('op_core_right');
    expect(existsSync(join(left.root, 'bots.json'))).toBe(false);
    expect(existsSync(join(right.root, 'bots.json'))).toBe(false);
  });

  it('keeps a promoted core-only root ready across launch-knob changes to its descriptor', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-core-knob-'));
    roots.push(root);
    const descriptor = (extra: Record<string, unknown>) => `${JSON.stringify([{
      larkAppId: 'local_riff',
      apiOnly: true,
      ...extra,
    }], null, 2)}\n`;
    let bytes = descriptor({ cliId: 'codex-app' });
    const control = createBotIdentityControlPlane({
      dataDir: root,
      readOnlyConfigBytes: () => bytes,
      allocateBotId: () => 'bot_core_knob',
      allocateOperationId: () => 'op_core_knob',
    });
    control.apply(control.report().operationId);
    expect(control.status()).toMatchObject({ kind: 'ready' });

    // Operator switches BOTMUX_CORE_CLI / model / workingDir: identity must not move.
    bytes = descriptor({ cliId: 'claude', model: 'opus', workingDir: '/elsewhere' });
    expect(control.status()).toMatchObject({ kind: 'ready' });
    expect(control.resolveActive({ kind: 'coreOnly', launchId: 'local_riff' }).botId)
      .toBe('bot_core_knob');
  });

  it('promotes only the exact source plan and fails closed if published identity disappears', () => {
    const { root, control } = fixture(['bot_promoted'], ['op_promote']);
    const plan = control.report();

    expect(control.status()).toMatchObject({ kind: 'planned', operationId: plan.operationId });
    const receipt = control.apply(plan.operationId);

    expect(receipt).toMatchObject({
      schemaVersion: 1,
      operationId: 'op_promote',
      registryDigest: plan.target.registryDigest,
    });
    expect(control.status()).toMatchObject({ kind: 'ready', revision: 1 });
    expect(control.resolveActive({ kind: 'lark', larkAppId: 'cli_same' })).toMatchObject({
      botId: 'bot_promoted',
      status: 'active',
    });
    expect(control.actorRef(
      { kind: 'lark', larkAppId: 'cli_same' },
      'session-1',
    )).toEqual({
      botId: 'bot_promoted',
      entityKind: 'session',
      entityId: 'session-1',
    });
    expect(JSON.parse(readFileSync(join(root, 'bot-identities.json'), 'utf8'))).toEqual(
      plan.targetRegistry,
    );
    expect(existsSync(join(root, 'bot-identity-intent.json'))).toBe(false);

    unlinkSync(join(root, 'bot-identities.json'));
    expect(control.status()).toMatchObject({ kind: 'needsRepair' });
    expect(() => control.resolveActive({ kind: 'lark', larkAppId: 'cli_same' }))
      .toThrow(/fail closed/i);
    expect(control.repair()).toMatchObject({ operationId: 'op_promote' });
    expect(control.status()).toMatchObject({ kind: 'ready', revision: 1 });
  });

  it('stays ready across runtime config writes and never demands repair for them', () => {
    const { configPath, control } = fixture(['bot_stable_ready'], ['op_stable']);
    control.apply(control.report().operationId);
    expect(control.status()).toMatchObject({ kind: 'ready' });

    // Secret rotation, display rename, and store-style field writes (the
    // rmwBotEntry family: /config set, dashboard defaults, vcMeeting seed…)
    // all mutate bots.json bytes without touching the active address set.
    writeFileSync(configPath, `${JSON.stringify([{
      larkAppId: 'cli_same',
      larkAppSecret: 'rotated-secret',
      displayName: 'renamed',
      vcMeetingConsumerProfile: { seeded: true },
    }], null, 2)}\n`);

    expect(control.status()).toMatchObject({ kind: 'ready', revision: 1 });
    expect(control.resolveActive({ kind: 'lark', larkAppId: 'cli_same' }).botId).toBe('bot_stable_ready');
    expect(() => control.report()).toThrow(/nothing to promote/i);
  });

  it('repair converges registry truth only and never rewrites the config authority', () => {
    const { root, configPath, control } = fixture(['bot_keep_config'], ['op_keep_config']);
    control.apply(control.report().operationId);

    const rotatedBytes = `${JSON.stringify([{
      larkAppId: 'cli_same',
      larkAppSecret: 'rotated-after-promotion',
      allowedUsers: ['user-added-later'],
    }], null, 2)}\n`;
    writeFileSync(configPath, rotatedBytes);
    writeFileSync(join(root, 'bot-identities.json'), '{bad json');
    expect(control.status()).toMatchObject({ kind: 'needsRepair' });

    control.repair();

    expect(control.status()).toMatchObject({ kind: 'ready', revision: 1 });
    expect(readFileSync(configPath, 'utf8')).toBe(rotatedBytes);
  });

  it('persists no config secrets into identity operation artifacts', () => {
    const { root, control } = fixture(['bot_no_leakage'], ['op_no_leakage']);
    control.apply(control.report().operationId);
    for (const name of readdirSync(join(root, 'bot-identity-ops'))) {
      expect(readFileSync(join(root, 'bot-identity-ops', name), 'utf8')).not.toContain('secret-cli_same');
    }
  });

  it('reports address-set drift as needsPromotion and treats App replacement as retire plus allocate', () => {
    const { configPath, control } = fixture(
      ['bot_original', 'bot_replacement', 'bot_reintroduced'],
      ['op_initial', 'op_replace', 'op_reintroduce'],
    );
    control.apply(control.report().operationId);

    writeFileSync(configPath, configBytes(['cli_new']));
    expect(control.status()).toMatchObject({
      kind: 'needsPromotion',
      revision: 1,
      operationId: 'op_initial',
    });
    expect(() => control.resolveActive({ kind: 'lark', larkAppId: 'cli_new' }))
      .toThrow(/fail closed/i);

    const replacementPlan = control.report();
    expect(replacementPlan.targetRegistry.bindings).toEqual([
      expect.objectContaining({
        botId: 'bot_original',
        status: 'retired',
        address: { kind: 'lark', larkAppId: 'cli_same' },
      }),
      expect.objectContaining({
        botId: 'bot_replacement',
        status: 'active',
        address: { kind: 'lark', larkAppId: 'cli_new' },
      }),
    ]);
    control.apply(replacementPlan.operationId);
    expect(control.status()).toMatchObject({ kind: 'ready', revision: 2 });
    expect(control.resolveActive({ kind: 'lark', larkAppId: 'cli_new' }).botId)
      .toBe('bot_replacement');
    expect(() => control.resolveActive({ kind: 'lark', larkAppId: 'cli_same' }))
      .toThrow(/no identity/i);

    writeFileSync(configPath, configBytes(['cli_same']));
    const reintroduced = control.report();
    expect(reintroduced.targetRegistry.bindings).toEqual([
      expect.objectContaining({ botId: 'bot_original', status: 'retired' }),
      expect.objectContaining({ botId: 'bot_replacement', status: 'retired' }),
      expect.objectContaining({ botId: 'bot_reintroduced', status: 'active' }),
    ]);
  });

  it('fails apply closed when the address set changes between report and apply', () => {
    const { configPath, control } = fixture(['bot_raced_apply'], ['op_raced']);
    const plan = control.report();
    writeFileSync(configPath, configBytes(['cli_same', 'cli_added_meanwhile']));
    expect(() => control.apply(plan.operationId)).toThrow(/run a fresh report/i);
    expect(existsSync(join(configPath, '..', 'bot-identities.json'))).toBe(false);
  });

  it('resumes a torn promotion, supports pre-commit rollback, and forbids identity rollback after receipt', () => {
    let crashOnce = true;
    const repairable = fixture(['bot_repairable'], ['op_repairable'], phase => {
      if (phase === 'registryPublished' && crashOnce) {
        crashOnce = false;
        throw new Error('simulated process death');
      }
    });
    const repairPlan = repairable.control.report();
    expect(() => repairable.control.apply(repairPlan.operationId)).toThrow(/process death/);
    expect(repairable.control.status()).toMatchObject({
      kind: 'needsRepair',
      operationId: repairPlan.operationId,
    });
    expect(repairable.control.repair()).toMatchObject({ operationId: repairPlan.operationId });
    expect(repairable.control.status()).toMatchObject({ kind: 'ready' });
    expect(() => repairable.control.rollback(repairPlan.operationId)).toThrow(/cannot be rolled back/);

    const rollback = fixture(['bot_rollback'], ['op_rollback'], phase => {
      if (phase === 'registryPublished') throw new Error('simulated process death');
    });
    const rollbackPlan = rollback.control.report();
    expect(() => rollback.control.apply(rollbackPlan.operationId)).toThrow(/process death/);
    expect(rollback.control.rollback()).toMatchObject({
      kind: 'planned',
      operationId: rollbackPlan.operationId,
    });
    expect(existsSync(join(rollback.root, 'bot-identities.json'))).toBe(false);
    expect(readFileSync(join(rollback.root, 'bots.json'), 'utf8')).toBe(configBytes(['cli_same']));
  });

  it('rejects collisions, corrupt truth, and a stale concurrent plan without inventing a winner', () => {
    const collision = fixture(['bot_collision', 'bot_collision'], ['op_collision']);
    writeFileSync(join(collision.root, 'bots.json'), configBytes(['cli_one', 'cli_two']));
    expect(() => collision.control.report()).toThrow(/collision/i);

    const concurrent = fixture(
      ['bot_first_identity', 'bot_second_identity'],
      ['op_first', 'op_second'],
    );
    const first = concurrent.control.report();
    const second = concurrent.control.report();
    concurrent.control.apply(first.operationId);
    expect(() => concurrent.control.apply(second.operationId)).toThrow(/source digest changed/i);
    writeFileSync(join(concurrent.root, 'bot-identities.json'), '{bad json');
    expect(concurrent.control.status()).toMatchObject({ kind: 'needsRepair' });
    expect(() => concurrent.control.resolveActive({ kind: 'lark', larkAppId: 'cli_same' }))
      .toThrow(/fail closed/i);
  });

  it('fails closed on promotion readback corruption and repairs only from the exact intent', () => {
    let root = '';
    let corruptOnce = true;
    const fixtureValue = fixture(['bot_readback'], ['op_readback'], phase => {
      if (phase === 'registryPublished' && corruptOnce) {
        corruptOnce = false;
        writeFileSync(join(root, 'bot-identities.json'), '{bad json');
      }
    });
    root = fixtureValue.root;
    const plan = fixtureValue.control.report();

    expect(() => fixtureValue.control.apply(plan.operationId)).toThrow(/readback mismatch/i);
    expect(fixtureValue.control.status()).toMatchObject({ kind: 'needsRepair' });
    expect(fixtureValue.control.repair()).toMatchObject({ operationId: plan.operationId });
    expect(fixtureValue.control.status()).toMatchObject({ kind: 'ready' });
  });
});
