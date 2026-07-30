import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Source-lock for PR D · API-only (core-only / headless) bot mode.
 *
 * apiOnly bots are driven purely over the HTTP control API and must NEVER
 * connect to Feishu at boot. The three boot-time coupling points — open_id
 * probe (/bot/v3/info), required-scope check, and the WSClient event
 * subscription — are each gated behind `!cfg.apiOnly` (or an `if (cfg.apiOnly)`
 * skip branch). These assertions pin that wiring so a refactor that drops a
 * guard turns red instead of silently making a headless bot dial Feishu.
 *
 * Negative-verified during authoring: removing any single guard fails this file.
 */
const daemonSource = readFileSync(resolve('src/daemon.ts'), 'utf8');
const registrySource = readFileSync(resolve('src/bot-registry.ts'), 'utf8');

function region(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  expect(start, `${startMarker} not found`).toBeGreaterThan(-1);
  expect(end, `${endMarker} not found after ${startMarker}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('API-only bot mode — boot-time Feishu decoupling (source lock)', () => {
  it('skips the open_id probe for apiOnly bots and seeds a synthetic identity', () => {
    const block = region(daemonSource, 'checkAllowedChatGroupsConfig(bot);', 'checkRequiredScopes(cfg.larkAppId)');
    // The probe lives in the `else` of an `if (cfg.apiOnly)` branch.
    expect(block).toContain('if (cfg.apiOnly) {');
    expect(block).toContain('bot.botOpenId ||= `bot_${cfg.larkAppId}`;');
    // The real probe must be on the non-apiOnly side.
    const apiOnlyBranch = block.indexOf('if (cfg.apiOnly) {');
    const probeCall = block.indexOf('probeBotOpenId(cfg.larkAppId).then(');
    const elseKeyword = block.indexOf('} else {', apiOnlyBranch);
    expect(elseKeyword).toBeGreaterThan(apiOnlyBranch);
    expect(probeCall).toBeGreaterThan(elseKeyword);
  });

  it('gates the required-scope check behind !cfg.apiOnly', () => {
    const block = region(daemonSource, 'Required-scope check: 启动后 best-effort 校验', '主动开工 — 场景①');
    expect(block).toContain('if (!cfg.apiOnly) {');
    expect(block).toContain('checkRequiredScopes(cfg.larkAppId)');
    expect(block.indexOf('if (!cfg.apiOnly) {'))
      .toBeLessThan(block.indexOf('checkRequiredScopes(cfg.larkAppId)'));
  });

  it('gates the WSClient event subscription behind !cfg.apiOnly', () => {
    const block = region(daemonSource, 'botHandlers.set(cfg.larkAppId, botEventHandlers);', 'recoverV3DistillationProposalsForBot');
    // botHandlers.set stays unconditional (replay paths may read it); only the
    // WSClient start is gated.
    expect(block).toContain('if (!cfg.apiOnly) {');
    expect(block).toContain('startLarkEventDispatcher(cfg.larkAppId, cfg.larkAppSecret, botEventHandlers');
    expect(block.indexOf('if (!cfg.apiOnly) {'))
      .toBeLessThan(block.indexOf('startLarkEventDispatcher('));
  });

  it('exempts apiOnly bots from the larkAppSecret requirement (registry)', () => {
    const block = region(registrySource, 'larkAppId is required and must be a string', 'MOSA-managed onboarding');
    expect(block).toContain("entry.apiOnly !== true && (!entry.larkAppSecret || typeof entry.larkAppSecret !== 'string')");
  });
});
