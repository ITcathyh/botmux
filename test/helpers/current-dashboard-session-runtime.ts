/** Explicit test composition for Dashboard SessionRuntime control routes. */

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { config } from '../../src/config.js';
import {
  setDashboardChatRename,
  setDashboardControlEffects,
  setDashboardHostMaintenance,
  setDashboardSessionRuntimeSubmitter,
} from '../../src/core/dashboard-ipc-server.js';
import { createCurrentDashboardChatRename } from '../../src/core/current-dashboard-chat-rename.js';
import { createCurrentDashboardControlEffects } from '../../src/core/current-dashboard-control-effects.js';
import {
  createCurrentDashboardAgentConfiguration,
  createCurrentDashboardHostMaintenance,
} from '../../src/core/current-dashboard-host-maintenance.js';
import { createCurrentDashboardSessionCommandClient } from '../../src/core/current-dashboard-session-command-client.js';
import { parseBotId } from '../../src/core/bot-identity.js';
import { createCurrentRouteScratchRetirementPort } from '../../src/core/current-route-scratch-retirement.js';
import { currentSessionActivationCoordinator } from '../../src/core/current-session-activation.js';
import { createCurrentSessionControlPort } from '../../src/core/current-session-control.js';
import {
  currentSessionRuntimeHost,
  type CurrentSessionRuntimeHost,
} from '../../src/core/current-session-runtime.js';
import * as sessionStore from '../../src/services/session-store.js';
import { activeSessionKey, type DaemonSession } from '../../src/core/types.js';

const syntheticDashboardSessions = new WeakSet<DaemonSession>();

let isolatedSessionStore: {
  readonly dataDir: string;
  readonly previousDataDir: string;
  readonly previousOwner: string;
} | undefined;

function normalizeDashboardSessionFixture(
  ds: DaemonSession,
  ownerLarkAppId = ds.larkAppId,
): void {
  const session = ds.session;
  const synthetic = !session.chatId
    || !session.rootMessageId
    || !session.title
    || !session.status
    || !session.createdAt;
  if (synthetic) syntheticDashboardSessions.add(ds);

  session.chatId ||= ds.chatId || `oc_dashboard_test_${session.sessionId}`;
  session.rootMessageId ||= `om_dashboard_test_${session.sessionId}`;
  session.title ||= `Dashboard test ${session.sessionId}`;
  session.status ||= 'active';
  session.createdAt ||= new Date(0).toISOString();
  if (ownerLarkAppId && !session.larkAppId) session.larkAppId = ownerLarkAppId;

  ds.larkAppId = ownerLarkAppId;
  ds.chatId ||= session.chatId;
  ds.chatType ||= session.chatType ?? 'group';
  ds.scope ||= session.scope ?? 'thread';
  ds.spawnedAt ??= 0;
  ds.cliVersion ??= 'dashboard-test';
  ds.lastMessageAt ??= 0;
  ds.hasHistory ??= false;
  ds.worker ??= null;
  ds.workerPort ??= null;
  ds.workerToken ??= null;
}

function bindDashboardSessionStore(
  ownerLarkAppId: string,
  activeSessions: ReadonlyMap<string, DaemonSession>,
  seedSessions: readonly ReturnType<typeof sessionStore.listSessions>[number][] = [],
  forceIsolation = false,
): void {
  const needsIsolation = forceIsolation || [...activeSessions.values()]
    .some(session => syntheticDashboardSessions.has(session));
  if (needsIsolation) {
    if (isolatedSessionStore) {
      throw new Error('Current Dashboard test Session store is already isolated');
    }
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-dashboard-runtime-'));
    isolatedSessionStore = {
      dataDir,
      previousDataDir: config.session.dataDir,
      previousOwner: sessionStore.currentSessionStoreOwner(),
    };
    config.session.dataDir = dataDir;
  }

  // Production binds the mutable legacy cache to the daemon owner before
  // composing Current. Tests do the same so lifecycle effects and the
  // owner-strict Directory observe one authority.
  sessionStore.init(ownerLarkAppId);
  for (const session of seedSessions) {
    sessionStore.updateSession({
      ...structuredClone(session),
      larkAppId: ownerLarkAppId,
    });
  }
  if (needsIsolation) {
    for (const ds of activeSessions.values()) sessionStore.updateSession(ds.session);
  }
}

/** Build the exact registry shape accepted by Current owner-bound adapters. */
export function currentDashboardSessionRegistry(
  ...sessions: DaemonSession[]
): Map<string, DaemonSession> {
  for (const session of sessions) normalizeDashboardSessionFixture(session);
  return new Map(sessions.map(session => [activeSessionKey(session), session]));
}

/**
 * Bind one owner and one stable active-session registry exactly as a daemon
 * process does. Tests must opt in: production and uncomposed test servers stay
 * fail-closed with `session_runtime_not_ready`.
 */
export function installCurrentDashboardSessionRuntimeForTest(
  ownerLarkAppId: string,
  activeSessions: Map<string, DaemonSession> = new Map(),
): void {
  const seedSessions = !ownerLarkAppId && activeSessions.size === 0
    ? sessionStore.listSessions().map(session => structuredClone(session))
    : [];
  const first = activeSessions.values().next().value as DaemonSession | undefined;
  const resolvedOwnerLarkAppId = ownerLarkAppId
    || first?.larkAppId
    || first?.session.larkAppId
    || 'cli_dashboard_runtime_test';
  const sessions = [...activeSessions.values()];
  activeSessions.clear();
  for (const session of sessions) {
    normalizeDashboardSessionFixture(session, resolvedOwnerLarkAppId);
    const key = activeSessionKey(session);
    if (activeSessions.has(key)) {
      throw new Error(
        `Current Dashboard test registry has duplicate canonical key for ${session.session.sessionId}`,
      );
    }
    activeSessions.set(key, session);
  }
  bindDashboardSessionStore(
    resolvedOwnerLarkAppId,
    activeSessions,
    seedSessions,
    !ownerLarkAppId,
  );
  const runtimeEpoch = `dashboard-test:${randomUUID()}`;
  const ownerBotId = parseBotId(`bot_${randomUUID().replaceAll('-', '')}`);
  const activation = currentSessionActivationCoordinator({
    ownerBotId,
    ownerLarkAppId: resolvedOwnerLarkAppId,
    runtimeEpoch,
    activeSessions,
  });
  let host: CurrentSessionRuntimeHost;
  const routeScratchRetirement = createCurrentRouteScratchRetirementPort({
    ownerLarkAppId: resolvedOwnerLarkAppId,
    downstream: () => host,
  });
  host = currentSessionRuntimeHost({
    ownerBotId,
    ownerLarkAppId: resolvedOwnerLarkAppId,
    activeSessions,
    ownerBootId: runtimeEpoch,
    runtimeEpoch,
    keyedTriggerAdmissionBlocked: () => false,
    controlMutation: createCurrentSessionControlPort({
      ownerBotId,
      ownerLarkAppId: resolvedOwnerLarkAppId,
      runtimeEpoch,
      activation,
      routeScratchRetirement,
      activeSessions,
    }),
  });

  const submit = createCurrentDashboardSessionCommandClient({
    ownerLarkAppId: () => resolvedOwnerLarkAppId,
    host: () => host,
  });
  setDashboardSessionRuntimeSubmitter(submit);
  setDashboardControlEffects(createCurrentDashboardControlEffects({
    ownerLarkAppId: resolvedOwnerLarkAppId,
    activeSessions,
  }));
  setDashboardHostMaintenance(createCurrentDashboardHostMaintenance({
    ownerLarkAppId: resolvedOwnerLarkAppId,
    activeSessions,
    listSessions: () => sessionStore.listSessionsForOwnerStrict(resolvedOwnerLarkAppId),
    submit,
    agentConfiguration: createCurrentDashboardAgentConfiguration(resolvedOwnerLarkAppId),
  }));
  setDashboardChatRename(createCurrentDashboardChatRename({
    ownerLarkAppId: resolvedOwnerLarkAppId,
    activeSessions,
    submit,
  }));
}

export function resetCurrentDashboardSessionRuntimeForTest(): void {
  setDashboardSessionRuntimeSubmitter(null);
  setDashboardControlEffects(null);
  setDashboardHostMaintenance(null);
  setDashboardChatRename(null);
  if (isolatedSessionStore) {
    const isolated = isolatedSessionStore;
    isolatedSessionStore = undefined;
    config.session.dataDir = isolated.previousDataDir;
    sessionStore.init(isolated.previousOwner || undefined);
    rmSync(isolated.dataDir, { recursive: true, force: true });
  }
}
