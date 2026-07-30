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
    // Returns '' (empty id), NOT the synthetic anchor — a fake id would be stored
    // as streamCardId and a later PATCH would dial Feishu (the codex round-3 P1).
    expect(block).toContain("return '';");
    expect(block).not.toContain('return anchor;');
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

describe('API-only bot mode — bot-level primitive boundary (source lock)', () => {
  const clientSource = readFileSync(resolve('src/im/lark/client.ts'), 'utf8');
  const workerPoolSource = readFileSync(resolve('src/core/worker-pool.ts'), 'utf8');

  it('every outbound Feishu primitive calls assertLarkTransport before getBotClient', () => {
    // The authoritative bot-level gate: no caller can reach Feishu for an apiOnly
    // bot, regardless of session context.
    for (const op of [
      'sendMessage', 'replyMessage', 'updateMessage', 'deleteMessage',
      'addReaction', 'removeReaction', 'sendUserMessage', 'sendEphemeralCard',
      'deleteEphemeralCard', 'uploadImage', 'uploadFile',
    ]) {
      expect(clientSource, op).toContain(`assertLarkTransport(larkAppId, '${op}')`);
    }
    // assertLarkTransport (early, op-named) throws the typed error for apiOnly.
    expect(clientSource).toContain('if (apiOnly) throw new LarkTransportDisabledError');
  });

  it('getBotClient is the authoritative bot-level gate (reads AND writes)', () => {
    // The true single chokepoint: EVERY Feishu call resolves its client here, so
    // gating getBotClient covers client.ts primitives, doc-comment drive API,
    // open-platform rename/avatar, identity cache — reads included (apiOnly =
    // zero Feishu network, not merely "no writes").
    const registrySource = readFileSync(resolve('src/bot-registry.ts'), 'utf8');
    const block = region(registrySource, 'export function getBotClient(', 'return bot.client;');
    expect(block).toContain('bot.config.apiOnly === true');
    expect(block).toContain('throw new LarkTransportDisabledError(larkAppId');
    // The error class is defined in bot-registry (no import cycle) and re-exported.
    expect(registrySource).toContain('export class LarkTransportDisabledError');
    expect(clientSource).toContain('export { LarkTransportDisabledError }');
  });

  it('downloadMessageResource gates BEFORE the app→user-token fallback', () => {
    // getBotClient throws for apiOnly; without an early gate the app-token attempt
    // is caught and silently falls back to a raw user-token fetch (codex round-5).
    const clientSource = readFileSync(resolve('src/im/lark/client.ts'), 'utf8');
    const block = region(clientSource, 'export async function downloadMessageResource(', 'Try App Token first');
    expect(block).toContain("assertLarkTransport(larkAppId, 'downloadMessageResource')");
  });

  it('worker-pool suppresses ALL aux UI for no-transport sessions at managedAuxUiSuppressed', () => {
    const block = region(workerPoolSource, 'const managedAuxUiSuppressed =', 'const managedFinalOutputSuppressed');
    expect(block).toContain('larkTransportEnabled({ chatId: ds.chatId, apiOnly: getBot(ds.larkAppId).config.apiOnly })');
  });

  it('scheduleCardPatch is a defense-in-depth no-op for no-transport sessions', () => {
    const block = region(workerPoolSource, 'export function scheduleCardPatch(', 'if (streamingCardDisabled(ds, turnId)) return;');
    expect(block).toContain('larkTransportEnabled({ chatId: ds.chatId, apiOnly: getBot(ds.larkAppId).config.apiOnly })');
  });

  it('botmux send refuses early for apiOnly bot AND any HTTP virtual-session turn (CLI capability gate)', () => {
    const cliSource = readFileSync(resolve('src/cli.ts'), 'utf8');
    const block = region(cliSource, 'async function cmdSend(', 'Managed output attribution');
    // apiOnly bot refusal.
    expect(block).toContain('currentBotIsApiOnly(selfAppId)');
    // Normal-bot-in-virtual-session refusal: BOTMUX_CHAT_ID = http_async_*/http_wait_*.
    expect(block).toContain("selfChatId.startsWith('http_async_') || selfChatId.startsWith('http_wait_')");
    expect(block).toContain('botmux send is unavailable for this turn');
  });
});

describe('API-only bot mode — non-client direct-Feishu paths (source lock)', () => {
  it('doc-comment driveApiCall enforces the same bot-level gate', () => {
    // doc-comment has its OWN drive API (subscribe/reply/comment/reaction) that
    // bypasses im/lark/client.ts — it must call assertLarkTransport too.
    const docSource = readFileSync(resolve('src/im/lark/doc-comment.ts'), 'utf8');
    const block = region(docSource, 'async function driveApiCall(', 'const bot = getBot(larkAppId);');
    expect(block).toContain('assertLarkTransport(larkAppId');
  });

  it('worker screenshot upload is disabled for apiOnly AND virtual-session (capability rides init)', () => {
    // The worker uploads via its OWN client (utils/lark-upload), bypassing the
    // daemon getBot gate, so the no-transport capability must ride the init
    // message. Covers apiOnly bot AND a normal bot in an HTTP virtual session.
    const workerSource = readFileSync(resolve('src/worker.ts'), 'utf8');
    expect(workerSource).toContain('apiOnlyForUpload = msg.apiOnly === true');
    expect(workerSource).toContain("msg.chatId?.startsWith('http_async_')");
    expect(workerSource).toContain("if (apiOnlyForUpload)");
    // worker-pool forwards apiOnly on the init message (both fork sites).
    const wpSource = readFileSync(resolve('src/core/worker-pool.ts'), 'utf8');
    expect((wpSource.match(/apiOnly: botCfg\.apiOnly/g) ?? []).length).toBeGreaterThanOrEqual(2);
    // And WITHHOLDS the real secret from a no-transport worker (removes the
    // capability rather than trusting a flag the sandboxed agent could flip).
    expect(wpSource).toContain("larkTransportEnabled({ chatId: ds.chatId, apiOnly: botCfg.apiOnly }) ? botCfg.larkAppSecret : ''");
  });
});

describe('API-only bot mode — apiOnly survives config reconstruction (source lock)', () => {
  it('worker init message + cred file + riff synthetic config all carry apiOnly', () => {
    const workerSource = readFileSync(resolve('src/worker.ts'), 'utf8');
    const cliSource = readFileSync(resolve('src/cli.ts'), 'utf8');
    // Worker forwards apiOnly into the sandbox env (riffModeSession reads it) and
    // persists it in the send-cred file (registerSelfFromCredFile reads it).
    expect(workerSource).toContain("sessionEnv.BOTMUX_API_ONLY = '1'");
    expect(workerSource).toContain('apiOnly: cfg.apiOnly');
    // riffModeSession synthetic BotConfig picks up the env flag.
    expect(cliSource).toContain("apiOnly: process.env.BOTMUX_API_ONLY === '1'");
    // registerSelfFromCredFile keeps apiOnly (and no longer bails on empty secret
    // when apiOnly — an apiOnly bot legitimately has none).
    expect(cliSource).toContain('cred.apiOnly === true');
  });
});
