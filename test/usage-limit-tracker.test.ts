/**
 * 限额状态机单测：扫屏门控 + 结构化限流的粘性重发。
 *
 * 背景：worker 的扫屏判定在 working/analyzing 帧被门控抑制（误报根治），
 * 但 Claude/Codex 的结构化限流是「一次性 emit + UUID 去重」的权威信号。
 * 若结构化限流命中后 CLI 仍被阻塞，而 worker 状态在 prompt 检测生效前
 * 投影为 working（projectRuntimeScreenStatus 在 promptReady=false 时的
 * 默认值就是 working），daemon 侧的 working 帧自愈会把这条权威限额清掉，
 * 且 Claude 家族的扫屏 rate 判定被 suppressRateKind 关闭，再也不会重新
 * 上报——真限流卡片被静默吞掉。因此结构化限额必须在本轮内逐帧重发，
 * 让 daemon 的「新鲜 usageLimit 优先」分支始终生效。
 *
 * Run: pnpm vitest run test/usage-limit-tracker.test.ts
 */
import { describe, expect, it } from 'vitest';
import { createUsageLimitTracker } from '../src/utils/usage-limit-tracker.js';
import type { CliUsageLimitState } from '../src/utils/cli-usage-limit.js';

function structuredLimit(): CliUsageLimitState {
  return {
    limited: true,
    kind: 'rate',
    retryAtMs: Date.now() + 60_000,
    retryLabel: '5-10 min',
    retryReady: false,
  };
}

describe('usage-limit tracker — 结构化限流粘性重发', () => {
  it('结构化限流命中后，working 帧仍重发 limited（防 daemon 自愈误清）', () => {
    const tracker = createUsageLimitTracker({ isRateKindSuppressed: () => false });
    const seq = tracker.beginTurn('');
    const limit = structuredLimit();
    tracker.noteStructuredLimit(limit);

    // 屏幕上没有任何限流文案、CLI 还在 working：扫屏门控会抑制，但权威
    // 结构化限额必须原样重发，daemon 收到新鲜 usageLimit 就不会自愈清除。
    const working = tracker.classify('模型正在输出业务 429 的排查结论', 'working');
    expect(working.status).toBe('limited');
    expect(working.usageLimit).toBe(limit);

    // idle 帧同样保持：CLI 被阻塞落到 idle，卡片不回落。
    const idle = tracker.classify('rate limit reached', 'idle');
    expect(idle.status).toBe('limited');
    expect(idle.usageLimit).toBe(limit);

    expect(tracker.detectedThisTurn(seq)).toBe(true);
  });

  it('analyzing 帧同样重发结构化限流', () => {
    const tracker = createUsageLimitTracker({ isRateKindSuppressed: () => false });
    tracker.beginTurn('');
    tracker.noteStructuredLimit(structuredLimit());
    expect(tracker.classify('thinking', 'analyzing').status).toBe('limited');
  });

  it('下一轮 beginTurn 后停止重发：限额卡片随新轮次清除', () => {
    const tracker = createUsageLimitTracker({ isRateKindSuppressed: () => false });
    tracker.beginTurn('');
    tracker.noteStructuredLimit(structuredLimit());
    expect(tracker.classify('anything', 'working').status).toBe('limited');

    tracker.beginTurn('');
    expect(tracker.classify('anything', 'working').status).toBe('working');
    expect(tracker.classify('anything', 'idle').status).toBe('idle');
  });

  it('扫屏命中保持一次性：不在后续帧重发（误报由 daemon 自愈兜底）', () => {
    const tracker = createUsageLimitTracker({ isRateKindSuppressed: () => false });
    tracker.beginTurn('');
    // idle 抖动帧扫屏命中。
    const detected = tracker.classify('429 Too Many Requests', 'idle');
    expect(detected.status).toBe('limited');
    expect(detected.usageLimit).toBeDefined();
    // 下一帧屏幕已无该文案（或状态变化）：不重发，daemon 可自愈清除。
    expect(tracker.classify('plain output', 'idle').status).toBe('idle');
    expect(tracker.classify('plain output', 'working').status).toBe('working');
  });

  it('扫屏门控保持不变：working 帧不出限额结论', () => {
    const tracker = createUsageLimitTracker({ isRateKindSuppressed: () => false });
    tracker.beginTurn('');
    expect(tracker.classify('429 Too Many Requests', 'working').status).toBe('working');
    expect(tracker.classify('429 Too Many Requests', 'analyzing').status).toBe('analyzing');
    // idle/stalled 帧维持原判定，真实限流（CLI 被阻塞）仍可检出。
    expect(tracker.classify('429 Too Many Requests', 'idle').status).toBe('limited');
    expect(tracker.classify('429 Too Many Requests', 'stalled').status).toBe('limited');
  });

  it('suppressRateKind 语义在结构化重发之外保持不变', () => {
    // Claude 家族：rate 被抑制，usage 仍检出；结构化重发不受影响。
    const suppressed = createUsageLimitTracker({ isRateKindSuppressed: () => true });
    suppressed.beginTurn('');
    expect(suppressed.classify('429 Too Many Requests', 'idle').status).toBe('idle');
    expect(suppressed.classify("You've hit your usage limit. Try again at 10:36 PM.", 'idle').status).toBe('limited');
    // 结构化限流即使在 suppressRateKind 下也重发。
    suppressed.noteStructuredLimit(structuredLimit());
    expect(suppressed.classify('output', 'working').status).toBe('limited');
  });
});
