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

  it('exempts apiOnly bots from the larkAppSecret requirement but still type-checks it (registry)', () => {
    const block = region(registrySource, 'larkAppId is required and must be a string', 'MOSA-managed onboarding');
    // apiOnly: secret may be omitted, but if present must still be a string.
    expect(block).toContain("if (entry.apiOnly === true) {");
    expect(block).toContain("entry.larkAppSecret !== undefined && typeof entry.larkAppSecret !== 'string'");
    // Normal bots keep the hard requirement.
    expect(block).toContain("} else if (!entry.larkAppSecret || typeof entry.larkAppSecret !== 'string') {");
  });
});

describe('API-only bot mode — runtime Feishu transport gates (source lock)', () => {
  const clientSource = readFileSync(resolve('src/im/lark/client.ts'), 'utf8');
  const triggerSource = readFileSync(resolve('src/core/trigger-session.ts'), 'utf8');

  it('gates the central sessionReply transport seam on larkTransportEnabled', () => {
    // Gating at sessionReply covers ALL auxiliary worker UI (ready/screen/tui/
    // stuck/startup+exit) by construction — the codex P1-1 fix.
    const block = region(daemonSource, 'async function sessionReply(', 'const hookContext = ds ?');
    expect(block).toContain('larkTransportEnabled({');
    expect(block).toContain('apiOnly: getBot(appId).config.apiOnly');
    expect(block).toContain('return anchor;'); // benign no-op sentinel
  });

  it('skips the getAvailableBots roster probe for no-transport sessions', () => {
    const block = region(triggerSource, 'Skip the Feishu roster probe', 'buildNewTopicCliInput(');
    expect(block).toContain('larkTransportEnabled({ chatId, apiOnly: bot.config.apiOnly })');
    expect(block).toContain('await getAvailableBots(larkAppId, chatId)');
    expect(block).toContain(': [];'); // empty roster when transport disabled
  });

  it('fail-closes the apiOnly trigger request shape (no real chat/root, requires HTTP mode)', () => {
    const block = region(triggerSource, "if (getBot(larkAppId).config.apiOnly === true) {", 'const dryRun =');
    expect(block).toContain('waitForFinalOutput && !req.options?.asyncReturnSessionId');
    expect(block).toContain('cannot target a Feishu rootMessageId');
    expect(block).toContain('cannot target a real Feishu chatId');
    expect(block).toContain('may only resume its own HTTP virtual session');
  });

  it('rejects botmux ask for no-transport sessions before the Lark dispatcher', () => {
    const block = region(daemonSource, "meeting receiver asks are not an idempotent managed action", 'canTalkChecker');
    expect(block).toContain('larkTransportEnabled({ chatId: askSession.chatId');
    expect(block).toContain("error: 'unsupported'");
  });

  it('excludes apiOnly bots from getAllBotClients (no normal-bot roster regression)', () => {
    const block = region(clientSource, 'function loadAllBotClientConfigs(', 'function getAllBotClients(');
    expect(block).toContain('c.apiOnly !== true');
    expect(block).toContain('.filter(notApiOnly)');
  });

  it('gates doc-subscription restore + comment poller behind !cfg.apiOnly', () => {
    const block = region(daemonSource, '文档订阅恢复 + 评论轮询', 'Sweep orphan sandbox trees');
    expect(block).toContain('if (!cfg.apiOnly) {');
    expect(block).toContain('restoreDocSubscriptions(activeSessions)');
    expect(block).toContain('pollWatchedDocComments(cfg.larkAppId)');
    expect(block.indexOf('if (!cfg.apiOnly) {'))
      .toBeLessThan(block.indexOf('restoreDocSubscriptions('));
  });

  it('gates allowedUsers contact resolution behind !cfg.apiOnly', () => {
    const block = region(daemonSource, 'Resolve allowed users per bot', 'needsResolve');
    expect(block).toContain('if (!cfg.apiOnly && ((bot.config.allowedUsers?.length');
  });
});

