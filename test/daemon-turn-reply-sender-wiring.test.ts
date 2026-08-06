import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const daemonSource = readFileSync(join(__dirname, '..', 'src', 'daemon.ts'), 'utf8');

describe('daemon per-turn reply sender wiring', () => {
  it('binds the accepted sender + is-bot on passthrough, initial, new-topic, existing-session and auto-create paths', () => {
    // passthrough object form
    expect(daemonSource).toMatch(/beginReplyTargetTurn\(ds, turn\.replyRootId,[\s\S]{0,360}senderOpenId: turn\.senderOpenId,[\s\S]{0,80}senderIsBot: turn\.senderIsBot/);
    // initial passthrough uses the caller-resolved is-bot (cross-ref included),
    // NOT a raw sender_type recompute (that was the cold-start gap).
    expect(daemonSource).toMatch(/beginReplyTargetTurn\(ds, replyRootId, messageId,[^\n]+senderOpenId, senderIsBot: resolvedSenderIsBot \}\);/);
    // new-topic
    expect(daemonSource).toMatch(/beginReplyTargetTurn\(ds, replyRootId, messageId,[^\n]+senderOpenId, senderIsBot: isForeignBotSender \|\|[^\n]+\}\);/);
    // existing-session
    expect(daemonSource).toMatch(/beginReplyTargetTurn\(ds, replyRootId, parsed\.messageId,[^\n]+senderOpenId: callerOpenId, senderIsBot: isForeignBot \}\);/);
    // auto-create
    expect(daemonSource).toMatch(/beginReplyTargetTurn\(newDs, replyRootId, parsed\.messageId,[^\n]+senderOpenId: senderOId, senderIsBot: isForeignBot \}\);/);
  });

  it('cold-start passthrough resolves is-bot from the caller (cross-ref), falling back to sender_type only when absent', () => {
    // The gap: startInitialPassthroughSession must not recompute is-bot from
    // parsed.senderType alone — a peer bot with a missing/changed sender_type
    // would be mis-attributed as human, re-blocking bot→bot --mention-back.
    expect(daemonSource).toMatch(/const resolvedSenderIsBot = senderIsBot \?\? \(parsed\.senderType === 'app' \|\| parsed\.senderType === 'bot'\);/);
    // All four in-function attribution points use the resolved value.
    expect(daemonSource).toContain('type: resolvedSenderIsBot ? \'bot\' as const : \'user\' as const,');
    expect(daemonSource).toContain('session.quoteTargetSenderIsBot = resolvedSenderIsBot;');
    expect(daemonSource).toMatch(/deliverPassthroughToExistingSession\([\s\S]{0,200}senderIsBot: resolvedSenderIsBot,/);
    // Both callers pass a cross-ref-resolved is-bot (not the raw sender_type),
    // kept separate from quota's botSender.
    expect(daemonSource).toMatch(/botSender: isBotSenderType,\n[\s\S]{0,400}senderIsBot: isForeignBotSender,/);
    expect(daemonSource).toMatch(/botSender: isBotSenderType \|\| isForeignBot,\n[\s\S]{0,400}senderIsBot: isBotSenderType \|\| isForeignBot,/);
  });

  it('does not invent a sender for scheduled or system-created turns', () => {
    expect(daemonSource).toContain('beginReplyTargetTurn(ds, sharedReplyRootId, sharedReplyRootId, new Date(now).toISOString());');
  });
});
