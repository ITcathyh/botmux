import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const daemonSource = readFileSync(join(__dirname, '..', 'src', 'daemon.ts'), 'utf8');

describe('daemon per-turn reply sender + participant wiring', () => {
  it('binds sender + turn-window participants on passthrough, initial, new-topic, existing-session and auto-create paths', () => {
    // passthrough object form (raw command → sender-only window)
    expect(daemonSource).toMatch(/beginReplyTargetTurn\(ds, turn\.replyRootId,[\s\S]{0,420}senderOpenId: turn\.senderOpenId,[\s\S]{0,140}participants: buildTurnParticipants\(larkAppId, turn\.senderOpenId, turn\.senderIsBot, undefined\)/);
    // initial passthrough (raw command → sender-only window, caller-resolved is-bot)
    expect(daemonSource).toMatch(/beginReplyTargetTurn\(ds, replyRootId, messageId,[^\n]+senderOpenId, participants: buildTurnParticipants\(larkAppId, senderOpenId, resolvedSenderIsBot, undefined\) \}\);/);
    // new-topic (business message → sender + parsed.mentions)
    expect(daemonSource).toMatch(/beginReplyTargetTurn\(ds, replyRootId, messageId,[^\n]+participants: buildTurnParticipants\(larkAppId, senderOpenId, isForeignBotSender \|\|[^\n]+parsed\.mentions\) \}\);/);
    // existing-session
    expect(daemonSource).toMatch(/beginReplyTargetTurn\(ds, replyRootId, parsed\.messageId,[^\n]+participants: buildTurnParticipants\(larkAppId, callerOpenId, isForeignBot, parsed\.mentions\) \}\);/);
    // auto-create
    expect(daemonSource).toMatch(/beginReplyTargetTurn\(newDs, replyRootId, parsed\.messageId,[^\n]+participants: buildTurnParticipants\(larkAppId, senderOId, isForeignBot, parsed\.mentions\) \}\);/);
  });

  it('buildTurnParticipants excludes the self bot and labels mentions via isKnownPeerBot', () => {
    // The helper's contract: sender + @-mentions, self bot dropped, each mention
    // labelled bot/person by isKnownPeerBot so the candidate list is accurate.
    expect(daemonSource).toContain('function buildTurnParticipants(');
    expect(daemonSource).toContain('const selfOpenId = getBot(larkAppId).botOpenId;');
    expect(daemonSource).toMatch(/if \(senderOpenId && senderOpenId !== selfOpenId\)/);
    expect(daemonSource).toMatch(/if \(!m\.openId \|\| m\.openId === selfOpenId\) continue;/);
    expect(daemonSource).toContain('isBot: isKnownPeerBot(config.session.dataDir, larkAppId, m.openId)');
  });

  it('cold-start passthrough resolves is-bot from the caller (cross-ref), falling back to sender_type only when absent', () => {
    // The gap: startInitialPassthroughSession must not recompute is-bot from
    // parsed.senderType alone — a peer bot with a missing/changed sender_type
    // would be mis-attributed as human, re-blocking bot→bot --mention-back.
    expect(daemonSource).toMatch(/const resolvedSenderIsBot = senderIsBot \?\? \(parsed\.senderType === 'app' \|\| parsed\.senderType === 'bot'\);/);
    // Both callers pass a cross-ref-resolved is-bot, kept separate from quota's botSender.
    expect(daemonSource).toMatch(/botSender: isBotSenderType,\n[\s\S]{0,400}senderIsBot: isForeignBotSender,/);
    expect(daemonSource).toMatch(/botSender: isBotSenderType \|\| isForeignBot,\n[\s\S]{0,400}senderIsBot: isBotSenderType \|\| isForeignBot,/);
  });

  it('does not invent a sender for scheduled or system-created turns', () => {
    expect(daemonSource).toContain('beginReplyTargetTurn(ds, sharedReplyRootId, sharedReplyRootId, new Date(now).toISOString());');
  });
});
