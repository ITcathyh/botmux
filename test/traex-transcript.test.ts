import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drainTraexRollout } from '../src/services/traex-transcript.js';

let dir: string;
let path: string;

function ev(obj: any): string {
  return JSON.stringify(obj) + '\n';
}

// TRAE user prompts share Codex's response_item/message shape.
function userResponseItem(text: string, ts = '2026-07-14T17:11:00.000Z') {
  return {
    timestamp: ts,
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
  };
}

// TRAE assistant messages are written WITHOUT a phase field, one per mid-turn
// step (commentary before a tool call as well as the final utterance). They
// are indistinguishable from each other in the response_item stream, so the
// drainer must NOT key finals off them.
function assistantMessage(text: string, ts = '2026-07-14T17:11:01.000Z') {
  return {
    timestamp: ts,
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
  };
}

function functionCall(name = 'shell', ts = '2026-07-14T17:11:02.000Z') {
  return { timestamp: ts, type: 'response_item', payload: { type: 'function_call', name } };
}

// The real per-turn completion boundary: exactly one task_complete event_msg
// per turn, carrying the final text verbatim in last_agent_message.
function taskComplete(lastAgentMessage: string | null, ts = '2026-07-14T17:11:03.000Z') {
  return {
    timestamp: ts,
    type: 'event_msg',
    payload: { type: 'task_complete', turn_id: 'turn-1', last_agent_message: lastAgentMessage, completed_at: 1, duration_ms: 1 },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'traex-transcript-'));
  path = join(dir, 'rollout.jsonl');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('drainTraexRollout', () => {
  it('takes the final answer from task_complete, not the assistant message', () => {
    // Real-shape simple turn: user prompt → phase-less assistant reply →
    // task_complete echoing the same text. Only ONE assistant_final, sourced
    // from task_complete.
    writeFileSync(path,
      ev(userResponseItem('给我打个招呼')) +
      ev(assistantMessage('你好！有什么可以帮你的吗？')) +
      ev(taskComplete('你好！有什么可以帮你的吗？')));
    const r = drainTraexRollout(path, 0);
    expect(r.events).toHaveLength(2);
    expect(r.events[0].kind).toBe('user');
    expect(r.events[0].text).toBe('给我打个招呼');
    expect(r.events[1].kind).toBe('assistant_final');
    expect(r.events[1].text).toBe('你好！有什么可以帮你的吗？');
  });

  it('does NOT emit mid-turn assistant messages that precede tool calls', () => {
    // The core bug this fix targets: a tool-using turn emits several phase-less
    // assistant messages (each followed by a function_call) before the real
    // answer. Only the terminal task_complete must close the turn — the mid-
    // turn "我先查一下…" must never surface as assistant_final.
    writeFileSync(path,
      ev(userResponseItem('查一下再回答')) +
      ev(assistantMessage('我先查一下……')) +
      ev(functionCall('shell')) +
      ev(assistantMessage('还需要再看一个文件……')) +
      ev(functionCall('shell')) +
      ev(assistantMessage('查完了，答案是 42。')) +
      ev(taskComplete('查完了，答案是 42。')));
    const r = drainTraexRollout(path, 0);
    // 1 user + exactly 1 final; the two mid-turn notes are dropped.
    expect(r.events.filter(e => e.kind === 'assistant_final')).toHaveLength(1);
    expect(r.events.find(e => e.kind === 'assistant_final')!.text).toBe('查完了，答案是 42。');
    // No mid-turn note leaked through.
    expect(r.events.some(e => e.text === '我先查一下……')).toBe(false);
    expect(r.events.some(e => e.text === '还需要再看一个文件……')).toBe(false);
  });

  it('one final per turn across multiple turns', () => {
    writeFileSync(path,
      ev(userResponseItem('第一个问题')) +
      ev(assistantMessage('中途…')) +
      ev(functionCall()) +
      ev(assistantMessage('答案一')) +
      ev(taskComplete('答案一', '2026-07-14T17:11:05.000Z')) +
      ev(userResponseItem('第二个问题', '2026-07-14T17:12:00.000Z')) +
      ev(assistantMessage('答案二', '2026-07-14T17:12:01.000Z')) +
      ev(taskComplete('答案二', '2026-07-14T17:12:02.000Z')));
    const r = drainTraexRollout(path, 0);
    const finals = r.events.filter(e => e.kind === 'assistant_final').map(e => e.text);
    expect(finals).toEqual(['答案一', '答案二']);
    const users = r.events.filter(e => e.kind === 'user').map(e => e.text);
    expect(users).toEqual(['第一个问题', '第二个问题']);
  });

  it('skips task_complete with empty / null last_agent_message (aborted / no-text turn)', () => {
    writeFileSync(path,
      ev(userResponseItem('start')) +
      ev(taskComplete(null)) +
      ev(userResponseItem('again', '2026-07-14T17:11:10.000Z')) +
      ev(taskComplete('')));
    const r = drainTraexRollout(path, 0);
    expect(r.events.filter(e => e.kind === 'assistant_final')).toHaveLength(0);
    expect(r.events.filter(e => e.kind === 'user')).toHaveLength(2);
  });

  it('incrementally drains an appended turn (mid-turn note then final)', () => {
    // Mirrors live split-live drain: attach mid-turn, then the tool call and
    // task_complete arrive later. The re-drain from newOffset must not double
    // count and must surface the final exactly once.
    writeFileSync(path,
      ev(userResponseItem('增量问题')) +
      ev(assistantMessage('我先查一下……')));
    const r1 = drainTraexRollout(path, 0);
    expect(r1.events.filter(e => e.kind === 'assistant_final')).toHaveLength(0);
    expect(r1.events.filter(e => e.kind === 'user')).toHaveLength(1);
    appendFileSync(path,
      ev(functionCall()) +
      ev(assistantMessage('查完了。')) +
      ev(taskComplete('查完了。')));
    const r2 = drainTraexRollout(path, r1.newOffset);
    expect(r2.events).toHaveLength(1);
    expect(r2.events[0].kind).toBe('assistant_final');
    expect(r2.events[0].text).toBe('查完了。');
  });

  it('uuid encodes path:byteStart and is stable across re-drains', () => {
    writeFileSync(path,
      ev(userResponseItem('u')) +
      ev(assistantMessage('mid')) +
      ev(taskComplete('final')));
    const r = drainTraexRollout(path, 0);
    expect(r.events[0].uuid).toMatch(/^.+\.jsonl:0$/);
    const r2 = drainTraexRollout(path, 0);
    expect(r2.events.map(e => e.uuid)).toEqual(r.events.map(e => e.uuid));
  });
});
