/**
 * Prompt-lane guards for the Current ordinary ingress.
 *
 * The ordinary (business-message) prompt lanes moved out of daemon.ts: the
 * Lark materializer src/im/lark/current-ordinary-ingress-production.ts renders
 * the legacy prompt and the codex-app structured sidecar, and the delivery
 * state (park vs send) is decided by classifyCurrentOrdinaryIngress in
 * src/core/current-ordinary-ingress.ts. The lane invariants are pinned here at
 * their new source locations, the same way this file always pinned them.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const materializerSource = readFileSync(
  resolve('src/im/lark/current-ordinary-ingress-production.ts'),
  'utf8',
);
const ingressSource = readFileSync(resolve('src/core/current-ordinary-ingress.ts'), 'utf8');

describe('Current ordinary ingress prompt lanes', () => {
  it('keeps a workflow command visible while hiding the generated skill prompt', () => {
    // The codex-app sidecar carries the RAW user-authored text; only the
    // wrapped legacy prompt gets the generated grill prompt, so the bot's
    // "what did the user type" lane never shows the synthesized skill text.
    expect(materializerSource).toContain('const visibleText = listenerPrompt ?? turn.content;');
    expect(materializerSource).toContain('codexAppText: visibleText,');
    expect(materializerSource).toMatch(
      /const userPrompt = quoteContext\s*\+ peerBotContext\s*\+ applicationContext\s*\+ \(workflowPrompt \?\? listenerPrompt \?\? turn\.content\);/,
    );
    // 话题上下文 (openingTopicContext) 必须双 lane 下发：既进 legacy prompt，
    // 也进 codex-app 结构化 sidecar，否则 codex-app bot 静默丢话题历史。
    expect(materializerSource).toContain(
      'const newTopicUserPrompt = openingTopicContext + userPrompt;',
    );
    expect(materializerSource).toContain(
      'codexAppMessageContext: (openingTopicContext + messageContext) || undefined,',
    );
  });

  it('retains VC lifecycle context in rewritten prompts without demoting it to untrusted', () => {
    // The VC lifecycle notice is application context. It must reach the
    // rewritten (workflow) prompt, but never the untrusted message-context
    // lane — which is exactly why messageContext omits applicationContext.
    expect(materializerSource).toMatch(
      /const messageContext = quoteContext\s*\+ peerBotContext\s*\+ \(workflowPrompt \?\? ''\);/,
    );
    expect(materializerSource).toContain('const applicationContext = vcApplicationContext(turn);');
    expect(materializerSource).toContain(
      'codexAppApplicationContext: applicationContext || undefined,',
    );
    // Behavioral counterpart: test/lark-current-ordinary-ingress-production.ts
    // renders one opening carrying both a workflow rewrite and a sealed VC
    // lifecycle and asserts botmux_application_context keeps 会议上下文状态.
  });

  it('does not buffer ordinary turns solely because repo commit UI cleanup is still in flight', () => {
    // The single delivery-state classifier parks on `pendingRepo` alone; a
    // repo-commit UI cleanup still in flight (pendingRepoCommitInFlight) must
    // never be a park condition of its own.
    expect(ingressSource).toContain("if (ds.pendingRepo) return 'parkPendingRepoFollower';");
    const classifier = ingressSource.slice(
      ingressSource.indexOf('export function classifyCurrentOrdinaryIngress('),
    );
    const body = classifier.slice(0, classifier.indexOf('\n}\n'));
    expect(body).not.toContain('pendingRepoCommitInFlight');
  });
});
