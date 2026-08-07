import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const daemonSource = readFileSync(join(__dirname, '..', 'src', 'daemon.ts'), 'utf8');

describe('daemon per-turn reply sender + participant wiring', () => {
  it('computes a turn window per path and binds participants + incomplete', () => {
    // passthrough (raw command → sender-only window)
    expect(daemonSource).toContain('buildTurnParticipants(larkAppId, turn.senderOpenId, turn.senderIsBot, undefined)');
    expect(daemonSource).toMatch(/participants: passthroughWindow\.participants,\s*participantsIncomplete: passthroughWindow\.incomplete/);
    // initial passthrough (raw command → caller-resolved is-bot, best-effort name)
    expect(daemonSource).toContain('buildTurnParticipants(larkAppId, senderOpenId, resolvedSenderIsBot, undefined, initialPassthroughSender?.name)');
    expect(daemonSource).toMatch(/participants: initialWindow\.participants, participantsIncomplete: initialWindow\.incomplete/);
    // new-topic (business message → sender + parsed.mentions + resolved name)
    expect(daemonSource).toMatch(/buildTurnParticipants\(larkAppId, senderOpenId, isForeignBotSender \|\|[^\n]+parsed\.mentions, newTopicSender\?\.name\)/);
    expect(daemonSource).toMatch(/participants: newTopicWindow\.participants, participantsIncomplete: newTopicWindow\.incomplete/);
    // existing-session (name best-effort omitted — resolves after the barrier)
    expect(daemonSource).toContain('buildTurnParticipants(larkAppId, callerOpenId, isForeignBot, parsed.mentions)');
    expect(daemonSource).toMatch(/participants: existingWindow\.participants, participantsIncomplete: existingWindow\.incomplete/);
    // auto-create
    expect(daemonSource).toContain('buildTurnParticipants(larkAppId, senderOId, isForeignBot, parsed.mentions, autoCreateSender?.name)');
    expect(daemonSource).toMatch(/participants: autoCreateWindow\.participants, participantsIncomplete: autoCreateWindow\.incomplete/);
  });

  it('buildTurnParticipants wraps the pure helper with live deps (self open_id + peer-bot predicate)', () => {
    // The self-exclusion / app_id-incomplete / three-state logic lives in the
    // pure buildTurnParticipantsFrom (behaviorally tested in reply-target-fallback);
    // the daemon wrapper just supplies getBot().botOpenId + isKnownPeerBot.
    expect(daemonSource).toContain('function buildTurnParticipants(');
    expect(daemonSource).toMatch(/return buildTurnParticipantsFrom\(\s*\{ openId: senderOpenId, isBot: senderIsBot, name: senderName \},/);
    expect(daemonSource).toContain('getBot(larkAppId).botOpenId,');
    expect(daemonSource).toContain('(openId) => isKnownPeerBot(config.session.dataDir, larkAppId, openId)');
  });

  it('cold-start passthrough resolves is-bot from the caller (cross-ref), falling back to sender_type only when absent', () => {
    expect(daemonSource).toMatch(/const resolvedSenderIsBot = senderIsBot \?\? \(parsed\.senderType === 'app' \|\| parsed\.senderType === 'bot'\);/);
    // Both callers pass a cross-ref-resolved is-bot, kept separate from quota's botSender.
    expect(daemonSource).toMatch(/botSender: isBotSenderType,\n[\s\S]{0,400}senderIsBot: isForeignBotSender,/);
    expect(daemonSource).toMatch(/botSender: isBotSenderType \|\| isForeignBot,\n[\s\S]{0,400}senderIsBot: isBotSenderType \|\| isForeignBot,/);
  });

  it('does not invent a sender for scheduled or system-created turns', () => {
    expect(daemonSource).toContain('beginReplyTargetTurn(ds, sharedReplyRootId, sharedReplyRootId, new Date(now).toISOString());');
  });
});
