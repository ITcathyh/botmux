import { describe, expect, it, vi } from 'vitest';

import type { SessionRow } from '../src/core/dashboard-rows.js';
import { composeDetail } from '../src/dashboard/session-card-model.js';
import type { CardActionData } from '../src/im/lark/card-handler.js';
import {
  buildSessionsDetailCard,
  handleSessionsCardAction,
  SESSIONS_ACTION_CLOSE,
  SESSIONS_ACTION_RESUME,
} from '../src/im/lark/sessions-card.js';

const OWNER = 'ou_sessions_card_operation_owner';
const APP = 'cli_sessions_card_operation';
const NOW = 2_000_000;

function row(status: SessionRow['status']): SessionRow {
  return {
    sessionId: 'session-card-operation',
    rootMessageId: 'om_session_card_operation',
    chatId: 'oc_session_card_operation',
    chatType: 'group',
    title: 'Operation receipt session',
    cliId: 'codex',
    workingDir: '/tmp',
    status,
    lastMessageAt: 1_000_000,
    cliVersion: 'test',
    webPort: status === 'closed' ? null : 7891,
    scope: 'thread',
    spawnedAt: 0,
    larkAppId: APP,
    isOncall: false,
    hasHistory: true,
  } as SessionRow;
}

function writeValue(card: unknown, action: string): Record<string, string> {
  const elements = (card as { elements?: unknown[] }).elements ?? [];
  for (const element of elements as Array<{ actions?: Array<{ value?: Record<string, string> }> }>) {
    const found = element.actions?.find(candidate => candidate.value?.action === action);
    if (found?.value) return found.value;
  }
  throw new Error(`missing ${action} button`);
}

function action(value: Record<string, string>): CardActionData {
  return {
    operator: { open_id: OWNER },
    action: { value },
    context: { open_message_id: 'om_sessions_card' },
  } as CardActionData;
}

describe('sessions card operation identity', () => {
  it('keeps callback retries stable while close → resume → close rebuilds use fresh identities', async () => {
    let current = row('idle');
    const posted: Array<{ path: string; body: unknown }> = [];
    const request = vi.fn(async (input: { method?: string; path: string; body?: unknown }) => {
      if (input.method === 'GET') {
        return { status: 200, body: { sessions: [current] }, raw: '' };
      }
      posted.push({ path: input.path, body: input.body });
      if (input.path.endsWith('/close')) current = row('closed');
      if (input.path.endsWith('/resume')) current = row('idle');
      return { status: 200, body: { ok: true }, raw: '' };
    });
    const deps = {
      createClient: () => ({ request }),
      getDashboardAdminOpenIds: () => [OWNER],
      locale: 'zh' as const,
      nowMs: () => NOW,
    };

    const initial = JSON.parse(buildSessionsDetailCard(composeDetail(current, NOW), {
      invokerOpenId: OWNER,
      locale: 'zh',
      nowMs: NOW,
      terminalUrl: null,
    }));
    const close = writeValue(initial, SESSIONS_ACTION_CLOSE);
    expect(close.operation_id).toMatch(/^dashboard-card:/);

    const closedResult = await handleSessionsCardAction(action(close), APP, deps);
    const resume = writeValue(closedResult.card?.data, SESSIONS_ACTION_RESUME);
    expect(posted[0]).toEqual({
      path: '/__daemon/sessions/session-card-operation/close',
      body: { operationId: close.operation_id },
    });
    expect(resume.operation_id).not.toBe(close.operation_id);

    const resumedResult = await handleSessionsCardAction(action(resume), APP, deps);
    const nextClose = writeValue(resumedResult.card?.data, SESSIONS_ACTION_CLOSE);
    expect(posted[1]).toEqual({
      path: '/__daemon/sessions/session-card-operation/resume',
      body: { operationId: resume.operation_id },
    });
    expect(nextClose.operation_id).not.toBe(close.operation_id);
    expect(nextClose.operation_id).not.toBe(resume.operation_id);
  });

  it('fails closed before Route B when a crafted write callback omits its identity', async () => {
    const request = vi.fn();
    const result = await handleSessionsCardAction(action({
      action: SESSIONS_ACTION_CLOSE,
      invoker_open_id: OWNER,
      session_id: 'session-card-operation',
    }), APP, {
      createClient: () => ({ request }),
      getDashboardAdminOpenIds: () => [OWNER],
      locale: 'zh',
      nowMs: () => NOW,
    });

    expect(result.toast?.content).toContain('bad_operation_id');
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    {
      actionName: SESSIONS_ACTION_CLOSE,
      initialStatus: 'idle' as const,
      committedStatus: 'closed' as const,
      nextAction: SESSIONS_ACTION_RESUME,
      route: 'close',
    },
    {
      actionName: SESSIONS_ACTION_RESUME,
      initialStatus: 'closed' as const,
      committedStatus: 'idle' as const,
      nextAction: SESSIONS_ACTION_CLOSE,
      route: 'resume',
    },
  ])('reaches the same Runtime receipt after $route response loss', async ({
    actionName,
    initialStatus,
    committedStatus,
    nextAction,
    route,
  }) => {
    let current = row(initialStatus);
    let postCount = 0;
    const postBodies: unknown[] = [];
    const request = vi.fn(async (input: { method?: string; path: string; body?: unknown }) => {
      if (input.method === 'GET') {
        return { status: 200, body: { sessions: [current] }, raw: '' };
      }
      postCount += 1;
      postBodies.push(input.body);
      current = row(committedStatus);
      if (postCount === 1) throw new Error('response lost after commit');
      return { status: 200, body: { ok: true }, raw: '' };
    });
    const deps = {
      createClient: () => ({ request }),
      getDashboardAdminOpenIds: () => [OWNER],
      locale: 'zh' as const,
      nowMs: () => NOW,
    };
    const initialCard = JSON.parse(buildSessionsDetailCard(composeDetail(current, NOW), {
      invokerOpenId: OWNER,
      locale: 'zh',
      nowMs: NOW,
      terminalUrl: null,
    }));
    const value = writeValue(initialCard, actionName);

    const lost = await handleSessionsCardAction(action(value), APP, deps);
    expect(lost.card).toBeUndefined();
    expect(lost.toast?.content).toContain('response lost after commit');

    const replay = await handleSessionsCardAction(action(value), APP, deps);
    expect(writeValue(replay.card?.data, nextAction)).toBeTruthy();
    expect(postCount).toBe(2);
    expect(postBodies).toEqual([
      { operationId: value.operation_id },
      { operationId: value.operation_id },
    ]);
    expect(request.mock.calls.filter(([input]) => input.path.endsWith(`/${route}`))).toHaveLength(2);
  });
});
