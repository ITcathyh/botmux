import { describe, expect, it } from 'vitest';
import {
  MAX_CONTENT_POLICY_REGEX_LENGTH,
  evaluateMessageListener,
  matchesContentPolicy,
  previewMessageListenerMatches,
} from '../src/services/message-listener.js';

function bot(config: any = {}, botOpenId = 'ou_self'): any {
  return { botOpenId, config: { larkAppId: 'app_listener', ...config } };
}

function textMessage(overrides: Record<string, unknown> = {}) {
  return {
    message_id: 'om_msg',
    chat_id: 'oc_chat',
    chat_type: 'group',
    message_type: 'text',
    content: JSON.stringify({ text: 'CPU 告警持续 5 分钟，ERROR 500' }),
    ...overrides,
  };
}

function listenerConfig(contentPolicy: unknown, extra: Record<string, unknown> = {}) {
  return {
    enabled: true,
    prompt: '判断是否需要响应告警',
    senderPolicy: { includeSenderOpenIds: ['ou_allowed'], includeSenderTypes: ['user'] },
    messagePolicy: { includeMsgTypes: ['text'], scope: 'top_level' },
    ...(contentPolicy ? { contentPolicy } : {}),
    ...extra,
  };
}

function evaluate(config: any, messageOverrides: Record<string, unknown> = {}, mention = false) {
  return evaluateMessageListener({
    bot: bot({ messageListeners: { oc_chat: config } }),
    chatId: 'oc_chat',
    message: textMessage(messageOverrides),
    senderOpenId: 'ou_allowed',
    senderTypeRaw: 'user',
    explicitlyMentionedThisBot: mention,
  });
}

describe('matchesContentPolicy', () => {
  it('matches everything when policy is absent or all-empty', () => {
    expect(matchesContentPolicy('任意文本', undefined)).toBe(true);
    expect(matchesContentPolicy('任意文本', {})).toBe(true);
    expect(matchesContentPolicy('任意文本', { includeKeywords: [] })).toBe(true);
    expect(matchesContentPolicy('任意文本', { includeRegex: [] })).toBe(true);
    expect(matchesContentPolicy('任意文本', { includeKeywords: [], includeRegex: [] })).toBe(true);
  });

  it('matches keywords case-insensitively as substrings (Chinese-friendly)', () => {
    expect(matchesContentPolicy('CPU 告警持续 5 分钟', { includeKeywords: ['告警'] })).toBe(true);
    expect(matchesContentPolicy('CPU 告警持续 5 分钟', { includeKeywords: ['报警'] })).toBe(false);
    expect(matchesContentPolicy('ERROR 500', { includeKeywords: ['error'] })).toBe(true);
    expect(matchesContentPolicy('Error 500', { includeKeywords: ['ERROR'] })).toBe(true);
    expect(matchesContentPolicy('出报错了', { includeKeywords: ['报错'] })).toBe(true);
  });

  it('matches regexes case-insensitively by default', () => {
    expect(matchesContentPolicy('ERROR 500', { includeRegex: ['error\\s+\\d+'] })).toBe(true);
    expect(matchesContentPolicy('error 500', { includeRegex: ['ERROR\\s+\\d+'] })).toBe(true);
    expect(matchesContentPolicy('ok', { includeRegex: ['\\d+'] })).toBe(false);
  });

  it('honors regexCaseSensitive for regexes while keywords stay case-insensitive', () => {
    expect(matchesContentPolicy('ERROR 500', { includeRegex: ['error'], regexCaseSensitive: true })).toBe(false);
    expect(matchesContentPolicy('ERROR 500', { includeRegex: ['ERROR'], regexCaseSensitive: true })).toBe(true);
    // Keywords are always case-insensitive regardless of the regex flag.
    expect(matchesContentPolicy('ERROR 500', { includeKeywords: ['error'], regexCaseSensitive: true })).toBe(true);
  });

  it('any mode (default): one keyword or one regex hit is enough', () => {
    expect(matchesContentPolicy('ERROR 500', { includeKeywords: ['不存在', '500'], matchMode: 'any' })).toBe(true);
    expect(matchesContentPolicy('ERROR 500', { includeRegex: ['nope', '\\d+'], matchMode: 'any' })).toBe(true);
    expect(matchesContentPolicy('ERROR 500', {
      includeKeywords: ['不存在'],
      includeRegex: ['\\d+'],
      matchMode: 'any',
    })).toBe(true);
    expect(matchesContentPolicy('plain text', {
      includeKeywords: ['nope'],
      includeRegex: ['\\d+'],
      matchMode: 'any',
    })).toBe(false);
    // Default mode is 'any' when omitted.
    expect(matchesContentPolicy('ERROR 500', { includeKeywords: ['不存在', '500'] })).toBe(true);
  });

  it('all mode: every keyword AND every regex must hit', () => {
    expect(matchesContentPolicy('ERROR 500', {
      includeKeywords: ['error', '500'],
      matchMode: 'all',
    })).toBe(true);
    expect(matchesContentPolicy('ERROR 500', {
      includeKeywords: ['error', '不存在'],
      matchMode: 'all',
    })).toBe(false);
    expect(matchesContentPolicy('ERROR 500', {
      includeRegex: ['error', '\\d+'],
      matchMode: 'all',
    })).toBe(true);
    expect(matchesContentPolicy('ERROR 500', {
      includeRegex: ['error', 'nope'],
      matchMode: 'all',
    })).toBe(false);
    // Both groups AND-ed: all keywords AND all regexes.
    expect(matchesContentPolicy('ERROR 500', {
      includeKeywords: ['error'],
      includeRegex: ['\\d+'],
      matchMode: 'all',
    })).toBe(true);
    expect(matchesContentPolicy('ERROR 500', {
      includeKeywords: ['error'],
      includeRegex: ['nope'],
      matchMode: 'all',
    })).toBe(false);
    // An empty regex group is vacuously satisfied in all mode.
    expect(matchesContentPolicy('ERROR 500', {
      includeKeywords: ['error'],
      includeRegex: [],
      matchMode: 'all',
    })).toBe(true);
  });

  it('treats invalid regex as non-matching without throwing', () => {
    expect(() => matchesContentPolicy('text', { includeRegex: ['[unterminated'] })).not.toThrow();
    expect(matchesContentPolicy('text', { includeRegex: ['[unterminated'] })).toBe(false);
    // One invalid pattern must not poison a valid sibling in any mode.
    expect(matchesContentPolicy('ERROR 500', { includeRegex: ['[unterminated', '\\d+'], matchMode: 'any' })).toBe(true);
    expect(matchesContentPolicy('ERROR 500', { includeRegex: ['[unterminated', '\\d+'], matchMode: 'all' })).toBe(false);
  });

  it('treats over-long regex (>500 chars) as non-matching', () => {
    const longPattern = 'a'.repeat(MAX_CONTENT_POLICY_REGEX_LENGTH + 1);
    expect(longPattern.length).toBeGreaterThan(MAX_CONTENT_POLICY_REGEX_LENGTH);
    expect(matchesContentPolicy('aaa', { includeRegex: [longPattern] })).toBe(false);
    // A 500-char pattern is still evaluated (250 optional 'a's match anything).
    const atLimit = 'a?'.repeat(MAX_CONTENT_POLICY_REGEX_LENGTH / 2);
    expect(atLimit.length).toBe(MAX_CONTENT_POLICY_REGEX_LENGTH);
    expect(matchesContentPolicy('aaa', { includeRegex: [atLimit] })).toBe(true);
  });
});

describe('evaluateMessageListener contentPolicy integration', () => {
  it('matches when the keyword policy hits', () => {
    const match = evaluate(listenerConfig({ includeKeywords: ['告警'] }));
    expect(match).toMatchObject({ messageText: 'CPU 告警持续 5 分钟，ERROR 500' });
  });

  it('does not match when the keyword policy misses', () => {
    expect(evaluate(listenerConfig({ includeKeywords: ['磁盘满'] }))).toBeUndefined();
  });

  it('does not match when the regex policy misses', () => {
    expect(evaluate(listenerConfig({ includeRegex: ['timeout'] }))).toBeUndefined();
  });

  it('applies matchMode all across keywords and regexes', () => {
    expect(evaluate(listenerConfig({
      includeKeywords: ['告警', '500'],
      includeRegex: ['ERROR'],
      matchMode: 'all',
    }))).toBeDefined();
    expect(evaluate(listenerConfig({
      includeKeywords: ['告警', '磁盘满'],
      matchMode: 'all',
    }))).toBeUndefined();
  });

  it('keeps matching every message when contentPolicy is absent (legacy default)', () => {
    expect(evaluate(listenerConfig(undefined))).toBeDefined();
    expect(evaluate(listenerConfig(null))).toBeDefined();
    expect(evaluate(listenerConfig({ includeKeywords: [], includeRegex: [] }))).toBeDefined();
  });

  it('does not affect the @-mention path: mentioned messages never go through the listener', () => {
    // Even a message that WOULD be filtered out by contentPolicy is simply not a
    // listener candidate when it explicitly mentions this bot — it keeps using
    // the normal mention route, and the listener never sees it.
    expect(evaluate(listenerConfig({ includeKeywords: ['不可能出现的词'] }), {}, true)).toBeUndefined();
    expect(evaluate(listenerConfig({ includeKeywords: ['告警'] }), {}, true)).toBeUndefined();
  });

  it('shares the filter with the preview leg (previewMessageListenerMatches)', () => {
    const state = bot({
      messageListeners: {
        oc_chat: listenerConfig({ includeKeywords: ['告警'] }),
      },
    });
    const messages = [
      textMessage({ message_id: 'om_1', content: JSON.stringify({ text: '无关内容' }) }),
      textMessage({ message_id: 'om_2', content: JSON.stringify({ text: 'CPU 告警' }) }),
    ];
    const matches = previewMessageListenerMatches({
      bot: state,
      chatId: 'oc_chat',
      messages,
      limit: 5,
      senderForMessage: () => ({ senderOpenId: 'ou_allowed', senderTypeRaw: 'user' }),
    });
    expect(matches.map(m => m.messageId)).toEqual(['om_2']);
  });
});
