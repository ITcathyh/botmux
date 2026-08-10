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
    // initial passthrough (raw command → tri-state is-bot for the label, best-effort name)
    expect(daemonSource).toContain('buildTurnParticipants(larkAppId, senderOpenId, resolvedSenderIsBotTriState, undefined, initialPassthroughSender?.name)');
    expect(daemonSource).toMatch(/participants: initialWindow\.participants, participantsIncomplete: initialWindow\.incomplete/);
    // The ordinary business-message lanes (new-topic / existing-session /
    // auto-create) no longer build a window here: they compile one
    // NormalizedOrdinaryImTurn and the window is built and bound to the turn in
    // src/core/current-ordinary-ingress-metadata.ts. That binding is covered
    // behaviorally by test/current-ordinary-ingress-metadata.test.ts (sender +
    // mentions + post @s → participants, self app_id-form excluded, unresolved
    // mention → participantsIncomplete, beginReplyTargetTurn(senderOpenId, …)).
  });

  it('every ordinary compile site folds the forward-seed post @s into the turn', () => {
    // Post rich-text @s live outside message.mentions[]; the ordinary lanes hand
    // them to the turn compiler as `postParticipantMentions`. A site that reads
    // only `data` silently drops a forwarded seed's post @s — the exact #750 bug
    // — so every compile site must fold the seed message in as well.
    expect(
      daemonSource.match(
        /postParticipantMentions: collectPostAtMentions\(\s*data\?\.message,\s*ctx\.forwardSeedData\?\.message,?\s*\)/g,
      ),
    ).toHaveLength(3); // new-topic + existing-session + auto-create
  });

  it('buildTurnParticipants concats pre-extracted post @s (extractPostAtParticipants) into the window', () => {
    // post rich-text @s live outside message.mentions[]; collectPostAtMentions
    // extracts them, buildTurnParticipants concats (not key/name-merged) so a post
    // "@self + @OtherBot" turn is not under-counted.
    expect(daemonSource).toContain('function collectPostAtMentions(');
    expect(daemonSource).toContain('return messages.flatMap(m => extractPostAtParticipants(m));');
    expect(daemonSource).toMatch(/\[\.\.\.\(mentions \?\? \[\]\), \.\.\.\(postAtMentions \?\? \[\]\)\]/);
  });

  it('senderIsBotTriState maps unknown → undefined (not human) and keeps routing boolean separate', () => {
    expect(daemonSource).toContain('function senderIsBotTriState(');
    expect(daemonSource).toMatch(/if \(isForeignBot \|\| senderType === 'app' \|\| senderType === 'bot'\) return true;/);
    expect(daemonSource).toMatch(/if \(senderType === 'user'\) return false;/);
    expect(daemonSource).toMatch(/return undefined;/);
  });

  it('buildTurnParticipants wraps the pure helper with live deps (self open_id + self app_id + peer predicate)', () => {
    // The self-exclusion / app_id-incomplete / three-state logic lives in the
    // pure buildTurnParticipantsFrom (behaviorally tested in reply-target-fallback);
    // the daemon wrapper supplies botOpenId + isKnownPeerBot + self larkAppId
    // (so an app_id-form self @ is excluded, not mis-counted as unresolved).
    expect(daemonSource).toContain('function buildTurnParticipants(');
    expect(daemonSource).toMatch(/return buildTurnParticipantsFrom\(\s*\{ openId: senderOpenId, isBot: senderIsBot, name: senderName \},/);
    expect(daemonSource).toContain('selfBot.botOpenId,');
    expect(daemonSource).toContain('(openId) => isKnownPeerBot(config.session.dataDir, larkAppId, openId)');
    expect(daemonSource).toContain('selfBot.config.larkAppId,');
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
