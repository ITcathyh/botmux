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
    // initial passthrough
    expect(daemonSource).toMatch(/beginReplyTargetTurn\(ds, replyRootId, messageId,[^\n]+senderOpenId, senderIsBot: parsed\.senderType === 'app' \|\| parsed\.senderType === 'bot' \}\);/);
    // new-topic
    expect(daemonSource).toMatch(/beginReplyTargetTurn\(ds, replyRootId, messageId,[^\n]+senderOpenId, senderIsBot: isForeignBotSender \|\|[^\n]+\}\);/);
    // existing-session
    expect(daemonSource).toMatch(/beginReplyTargetTurn\(ds, replyRootId, parsed\.messageId,[^\n]+senderOpenId: callerOpenId, senderIsBot: isForeignBot \}\);/);
    // auto-create
    expect(daemonSource).toMatch(/beginReplyTargetTurn\(newDs, replyRootId, parsed\.messageId,[^\n]+senderOpenId: senderOId, senderIsBot: isForeignBot \}\);/);
  });

  it('does not invent a sender for scheduled or system-created turns', () => {
    expect(daemonSource).toContain('beginReplyTargetTurn(ds, sharedReplyRootId, sharedReplyRootId, new Date(now).toISOString());');
  });
});
