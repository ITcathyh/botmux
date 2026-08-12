#!/usr/bin/env node

/**
 * Prove which Session mutation paths are behind SessionRuntime and which ones
 * remain explicit Target-A bypasses. The checked-in ledger is descriptive;
 * source and the A0 authority inventory are the evidence.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), '..');
const ledgerPath = resolve(repoRoot, 'docs/architecture/session-runtime-coverage.json');
const authorityInventoryRelativePath = 'docs/architecture/session-authority-inventory.json';
const authorityInventoryPath = resolve(repoRoot, authorityInventoryRelativePath);

const expectedCoverage = new Map([
  ['keyed-trigger-start', { targetMilestone: 'A1', disposition: 'migrated' }],
  ['current-session-store-adapter', { targetMilestone: 'A1', disposition: 'migrated' }],
  ['ordinary-im', { targetMilestone: 'C1', disposition: 'migrated' }],
  ['dashboard-control', { targetMilestone: 'C2', disposition: 'migrated' }],
  ['remaining-control-bypass', { targetMilestone: 'C2', disposition: 'remaining' }],
  ['executor-generation', { targetMilestone: 'A2', disposition: 'migrated' }],
  ['per-session-command-lane', { targetMilestone: 'A3', disposition: 'migrated' }],
  ['scheduler', { targetMilestone: 'C4', disposition: 'migrated' }],
  ['scheduler-retained-projection', { targetMilestone: 'C4', disposition: 'retained' }],
  ['activation-restore', { targetMilestone: 'A4', disposition: 'migrated' }],
  ['path-specific-retained', { targetMilestone: 'Target-A', disposition: 'retained' }],
  ['projection', { targetMilestone: 'C3', disposition: 'migrated' }],
  ['remaining-bypass', { targetMilestone: 'Target-A', disposition: 'remaining' }],
]);

const retainedForbiddenAccessLanes = new Set([
  'direct-caller-mutation',
  'session-store-api',
]);

const mandatoryForbiddenCalls = [
  'sessionStore.createSession',
  'sessionStore.createSessionExact',
  'sessionStore.updateSession',
  'sessionStore.closeSession',
  'activeSessions.set',
  'activeSessions.delete',
  'forkWorker',
  'forkSession',
  'closeSession',
];
const mandatoryPureRuntimeSources = ['src/core/session-runtime.ts'];
const mandatoryForbiddenImports = ['../services/session-store.js', './worker-pool.js'];
const mandatoryProjectionProductionBinding = {
  protocolSource: 'src/core/dashboard-projection.ts',
  eventSource: 'src/core/dashboard-events.ts',
  sessionRuntimeSource: 'src/core/session-runtime.ts',
  currentProjectionSource: 'src/core/current-session-runtime.ts',
  ipcSource: 'src/core/dashboard-ipc-server.ts',
  aggregatorSource: 'src/dashboard/aggregator.ts',
  dashboardSource: 'src/dashboard.ts',
  webStoreSource: 'src/dashboard/web/store.ts',
  daemonSource: 'src/daemon.ts',
};
const executorRuntimeAccessLane = 'session-executor-runtime-adapter';
const mandatoryExecutorObservationKinds = [
  'inputReceived',
  'inputRejected',
  'inputCommitted',
  'turnTerminal',
  'cliExit',
  'workerExit',
];
const mandatoryExecutorSelectors = new Map([
  ['src/core/current-session-executor-runtime.ts', [
    'commitNext',
    'fenceExit',
    'reconcilePendingExitFence',
    'reconcilePendingReservation',
  ]],
  ['src/core/current-dispatch-input-commit-evidence.ts', [
    'record',
    'synchronizeReceipts',
  ]],
  ['src/core/dispatch.ts', ['recordDispatchInputCommit']],
  ['src/core/worker-pool.ts', [
    'reduceExit',
    'retireWorkerAfterUnknownGeneration',
    'setupWorkerHandlers',
  ]],
  ['src/core/trigger-session.ts', ['convergeIdempotentAsyncTurnOnWorkerExit']],
]);

const mandatorySessionLaneBinding = Object.freeze({
  laneSource: 'src/core/session-command-lane.ts',
  laneFactory: 'createSessionCommandLaneHost',
  currentLaneSource: 'src/core/current-session-command-lane.ts',
  sharedLaneExport: 'currentSessionCommandLane',
  sessionRuntimeSource: 'src/core/session-runtime.ts',
  sessionRuntimeFactory: 'createSessionRuntimeHost',
  sessionSubmitFunction: 'submit',
  sessionTransitionFunction: 'run',
  ordinaryEffectRunnerFunction: 'runOrdinaryEffects',
  ordinaryResumeFunction: 'resumeOrdinaryAttempt',
  synchronousPortGuardFunction: 'invokeSynchronousPort',
  currentSessionRuntimeSource: 'src/core/current-session-runtime.ts',
  currentSessionRuntimeFactory: 'currentSessionRuntimeHost',
  ordinaryPolicySource: 'src/core/current-ordinary-ingress.ts',
  ordinaryPolicyFactory: 'createCurrentOrdinaryIngressPort',
  ordinaryProductionWired: true,
  executorRuntimeSource: 'src/core/session-executor-runtime.ts',
  executorRuntimeFactory: 'createSessionExecutorRuntime',
  currentExecutorAdapterSource: 'src/core/current-session-executor-runtime.ts',
  currentExecutorAdapterFactory: 'createCurrentSessionExecutorRuntime',
  workerSource: 'src/core/worker-pool.ts',
  handlerFunction: 'setupWorkerHandlers',
  reportCallCount: 7,
  resumeCallCount: 4,
});

const mandatoryOrdinaryProductionBinding = Object.freeze({
  daemonSource: 'src/daemon.ts',
  daemonHostFactory: 'currentDaemonSessionRuntimeHost',
  currentRuntimeSource: 'src/core/current-session-runtime.ts',
  currentRuntimeFactory: 'currentSessionRuntimeHost',
  ingressDaemonSource: 'src/im/lark/current-ordinary-ingress-daemon.ts',
  ingressDaemonFactory: 'createCurrentOrdinaryIngressDaemonPort',
  ingressLarkSource: 'src/im/lark/current-ordinary-ingress-production.ts',
  ingressLarkFactory: 'createLarkCurrentOrdinaryIngressProductionPort',
  ingressCoreSource: 'src/core/current-ordinary-ingress-production.ts',
  ingressCoreFactory: 'createCurrentOrdinaryIngressProductionPort',
  routeOpeningSource: 'src/core/current-ordinary-route-opening-production.ts',
  routeOpeningFactory: 'createCurrentOrdinaryRouteOpeningProduction',
  routeRegistrySource: 'src/core/current-ordinary-route-registry.ts',
  routeRegistryFactory: 'createCurrentOrdinaryRouteRegistryRuntime',
  pendingRepoSubmitSource: 'src/core/current-pending-repo-completion-submit.ts',
  pendingRepoPortFactory: 'currentPendingRepoCompletionPort',
  pendingRepoSubmitFunction: 'submitCurrentPendingRepoCompletion',
  pendingRepoProductionSource: 'src/core/current-pending-repo-completion-production.ts',
  pendingRepoProductionFactory: 'createCurrentPendingRepoCompletionProduction',
  pendingRepoDispatchFunction: 'dispatchWorker',
  ordinaryQueuedActivationRecoveryFunction: 'apply',
  queuedActivationRecoveryFunction: 'prepareQueuedActivationRecoveryFork',
});

const mandatorySchedulerProductionBinding = Object.freeze({
  producerSource: 'src/core/scheduler.ts',
  submitSetter: 'setSubmitCallback',
  deadlineProducer: 'tick',
  manualProducer: 'runNow',
  identitySource: 'src/core/scheduled-fire.ts',
  daemonSource: 'src/daemon.ts',
  daemonFunction: 'startDaemon',
  daemonHostFactory: 'currentDaemonScheduledFireRuntimeHost',
  runtimeSource: 'src/core/session-runtime.ts',
  runtimeFactory: 'createSessionRuntimeHost',
  currentRuntimeSource: 'src/core/current-session-runtime.ts',
  currentRuntimeFactory: 'currentSessionRuntimeHost',
  adapterSource: 'src/core/current-scheduled-fire.ts',
  adapterFactory: 'createCurrentScheduledFireAdapter',
  legacyBridgeSource: 'src/core/session-manager.ts',
  legacyBridgeFunction: 'executeScheduledTask',
  commandKind: 'scheduled.fire',
  durability: 'processLocal',
});

const mandatorySchedulerForbiddenProducerCalls = [
  'sessionStore.createSession',
  'sessionStore.updateSession',
  'activeSessions.set',
  'activeSessions.delete',
  'forkWorker',
  'sendWorkerInput',
];

const mandatoryOrdinaryAuthoritySelectors = new Map([
  ['src/core/current-ordinary-ingress-metadata.ts', ['apply']],
  ['src/core/current-ordinary-ingress-production.ts', [
    'admitTail',
    'apply',
    'rememberAcceptedInput',
    'restoreTransientGate',
    'stageActivationJournal',
    'stagePendingRepoOpening',
  ]],
  ['src/core/current-ordinary-route-opening-production.ts', ['publish', 'rollback']],
  ['src/core/current-ordinary-route-registry.ts', ['inspectExisting', 'publish']],
  ['src/core/current-pending-repo-completion-production.ts', ['dispatchWorker']],
  ['src/core/current-pending-repo-completion.ts', [
    'begin',
    'clearExactPendingClaim',
    'clearFoldedRuntimeBuffers',
    'restoreRuntime',
    'resume',
    'rollbackProvenWorkerRefusalCandidate',
  ]],
]);

const mandatoryActivationTailAuthoritySelector = Object.freeze({
  sourceFile: 'src/core/worker-pool.ts',
  enclosingFunctions: Object.freeze([
    'prepareQueuedActivationRecoveryFork',
    'promoteQueuedActivationTailTyped',
  ]),
});

const mandatoryActivationProductionBinding = Object.freeze({
  runtimeSource: 'src/core/session-activation-runtime.ts',
  runtimeFactory: 'createSessionActivationRuntime',
  currentAdapterSource: 'src/core/current-session-activation.ts',
  currentAdapterFactory: 'createCurrentSessionActivationPort',
  coordinatorFactory: 'currentSessionActivationCoordinator',
  sharedLaneSource: 'src/core/current-session-command-lane.ts',
  sharedLaneExport: 'currentSessionCommandLane',
  laneAddressFactory: 'currentSessionLaneAddress',
  currentRuntimeSource: 'src/core/current-session-runtime.ts',
  currentRuntimeFactory: 'currentSessionRuntimeHost',
  daemonSource: 'src/daemon.ts',
  daemonFactory: 'currentDaemonSessionActivation',
  providerSource: 'src/core/worker-pool.ts',
  managedProvider: 'forkWorker',
  adoptProvider: 'forkAdoptWorker',
  typedTailRecovery: 'prepareQueuedActivationRecoveryFork',
  typedTailPromotion: 'promoteQueuedActivationTailTyped',
  generationOracle: 'test/current-session-executor-runtime.test.ts',
  workerExitOracle: 'test/session-lifecycle-hooks.test.ts',
  restoreOracle: 'test/restore-zombie-close.test.ts',
  terminalOracle: 'test/session-terminal-activation.test.ts',
});

const mandatoryActivationCallerCuts = new Map([
  ['src/core/current-ordinary-ingress-worker-processes.ts#createCurrentOrdinaryIngressWorkerProcesses', 'ensure'],
  ['src/core/current-keyed-trigger-turn.ts#createCurrentKeyedTriggerTurnPort', 'ensure'],
  ['src/core/current-pending-repo-completion-production.ts#createCurrentPendingRepoCompletionProduction', 'ensure'],
  ['src/core/current-pending-repo-completion-submit.ts#submitCurrentPendingRepoCompletion', 'currentSessionActivationCoordinator'],
  ['src/core/current-scheduled-fire.ts#createCurrentScheduledFireAdapter', 'ensure'],
  ['src/core/session-manager.ts#resumeRestoredPendingRepoSetup', 'reconcile'],
  ['src/core/session-manager.ts#restoreActiveSessions', 'reconcile'],
  ['src/core/session-manager.ts#ensureTerminalWorkerPort', 'reconcileCurrentSessionActivation'],
  ['src/daemon.ts#currentDaemonSessionRuntimeHost', 'currentDaemonSessionActivation'],
  ['src/daemon.ts#prewarmDocCommentSession', 'ensure'],
  ['src/daemon.ts#handleDocCommentAdmitted', 'ensure'],
  ['src/im/lark/card-handler.ts#handleCardAction', 'ensure'],
]);

const mandatoryActivationLegacyPartition = Object.freeze({
  originalMutationCount: 343,
  migratedProviderMutationCount: 226,
  reclassifiedOtherMutationCount: 117,
  explicitLifecycleControl: 53,
  activeRouteMaintenance: 6,
  freshSessionCreation: 30,
  generationPrecommitCreation: 28,
});

// C2 is a caller cut, not a claim over every historical "control" writer.
// These bindings name the deep Dashboard command seam; the exact authority
// selectors are validated separately once the source census has identified
// the Current adapters that implement it. Command/card/shared providers that
// still mutate directly get their own `remaining-control-bypass` partition;
// unrelated Target-A gaps remain in the final `remaining-bypass` partition.
const mandatoryControlProductionBinding = Object.freeze({
  ipcSource: 'src/core/dashboard-ipc-server.ts',
  operationIdReader: 'sessionOperationId',
  commandClientSource: 'src/core/current-dashboard-session-command-client.ts',
  commandClientFactory: 'createCurrentDashboardSessionCommandClient',
  currentRuntimeSource: 'src/core/current-session-runtime.ts',
  currentRuntimeFactory: 'currentSessionRuntimeHost',
  runtimeSource: 'src/core/session-runtime.ts',
  runtimeFactory: 'createSessionRuntimeHost',
  runtimeSubmitFunction: 'submit',
  mutationEffectRunner: 'runControlMutationEffects',
  mutationResumeFunction: 'resumeControlMutationAttempt',
  renameEffectRunner: 'runControlRenameEffect',
  controlSource: 'src/core/current-session-control.ts',
  controlFactory: 'createCurrentSessionControlPort',
  cwdSource: 'src/core/session-cwd.ts',
  cwdCurrentPublisher: 'syncCurrentSessionWorkingDir',
  cwdRemainingPublisher: 'repinSessionWorkingDir',
  openingSource: 'src/core/current-dashboard-route-opening.ts',
  openingFactory: 'createCurrentDashboardRouteOpeningPort',
  dashboardOpeningBarrierSource: 'src/core/session-manager.ts',
  dashboardOpeningBarrierFunction: 'spawnDashboardSession',
  routeRegistrySource: 'src/core/current-ordinary-route-registry.ts',
  routeRegistryFactory: 'createCurrentOrdinaryRouteRegistryRuntime',
  routeAdmissionSource: 'src/core/current-route-admission.ts',
  routeAdmissionFactory: 'reserveCurrentRouteAdmission',
  triggerSource: 'src/core/trigger-session.ts',
  triggerFunction: 'triggerSessionTurnAdmitted',
  maintenanceSource: 'src/core/current-dashboard-host-maintenance.ts',
  maintenanceFactory: 'createCurrentDashboardHostMaintenance',
  chatRenameSource: 'src/core/current-dashboard-chat-rename.ts',
  chatRenameFactory: 'createCurrentDashboardChatRename',
  aggregatorSource: 'src/dashboard.ts',
  createOperationHostFactory: 'createDashboardSessionCreateOperationHost',
  idleOperationHostFactory: 'createDashboardIdleCleanupOperationHost',
  aggregatorOperationIdReader: 'requiredDashboardSessionCreateOperationId',
  idleChildExecutor: 'executeDashboardIdleCleanupChild',
  webOperationSource: 'src/dashboard/web/operation-id.ts',
  webOperationCoordinator: 'SemanticOperationCoordinator',
  sessionsCardSource: 'src/im/lark/sessions-card.ts',
  sessionsCardBuilder: 'buildSessionsDetailCard',
  sessionsCardHandler: 'handleSessionsCardAction',
  daemonSource: 'src/daemon.ts',
  daemonHostFactory: 'currentDaemonSessionRuntimeHost',
  daemonActivationFactory: 'currentDaemonSessionActivation',
  activationCoordinatorFactory: 'currentSessionActivationCoordinator',
  operationReceiptDurability: 'daemonEpoch',
});

const mandatoryControlRoutes = new Map([
  ['GET /api/sessions/:sessionId/trigger-result', {
    sink: 'buildAsyncTriggerLookupResponse',
    delegatedFunction: 'buildAsyncTriggerLookupResponse',
    delegatedSink: 'dashboardSessionRuntimeSubmitter',
    commandKind: 'control.mutate',
    identitySource: 'derived-trigger-id',
  }],
  ['POST /api/sessions/:sessionId/close', {
    sink: 'dashboardSessionRuntimeSubmitter',
    commandKind: 'control.mutate',
  }],
  ['POST /api/sessions/:sessionId/prune', {
    sink: 'dashboardSessionRuntimeSubmitter',
    commandKind: 'control.mutate',
  }],
  ['POST /api/sessions/:sessionId/restart', {
    sink: 'submitControl',
    commandKind: 'control.mutate',
  }],
  ['POST /api/sessions/:sessionId/suspend', {
    sink: 'submitControl',
    commandKind: 'control.mutate',
  }],
  ['POST /api/host-overload/sweep', {
    sink: 'maintenance.sweep',
  }],
  ['POST /api/sessions/:sessionId/slash', {
    sink: 'submit',
    commandKind: 'control.mutate',
  }],
  ['POST /api/sessions/:sessionId/chat-rename', {
    sink: 'port.submit',
  }],
  ['POST /api/sessions/:sessionId/cd', {
    sink: 'submitControl',
    commandKind: 'control.mutate',
  }],
  ['POST /api/sessions/:sessionId/board', {
    sink: 'dashboardSessionRuntimeSubmitter',
    commandKind: 'control.mutate',
  }],
  ['POST /api/sessions/:sessionId/whiteboard', {
    sink: 'dashboardSessionRuntimeSubmitter',
    commandKind: 'control.mutate',
  }],
  ['POST /api/sessions/:sessionId/start', {
    sink: 'submit',
    commandKind: 'control.mutate',
  }],
  ['POST /api/sessions/spawn', {
    sink: 'submit',
    commandKind: 'dashboard.spawn',
  }],
  ['POST /api/sessions/:sessionId/rename', {
    sink: 'dashboardSessionRuntimeSubmitter',
    commandKind: 'control.rename',
  }],
  ['POST /api/sessions/:sessionId/lock', {
    sink: 'dashboardSessionRuntimeSubmitter',
    commandKind: 'control.mutate',
  }],
  ['POST /api/sessions/:sessionId/resume', {
    sink: 'dashboardSessionRuntimeSubmitter',
    commandKind: 'control.mutate',
  }],
  ['POST /api/sessions/migrate-to-chat', {
    sink: 'submitControl',
    commandKind: 'control.mutate',
  }],
  ['PUT /api/bot-agent', {
    sink: 'maintenance.changeAgent',
  }],
].map(([route, proof]) => [
  route,
  { identitySource: 'caller-supplied', ...proof },
]));

const mandatoryControlForbiddenCallerCalls = [
  'sessionStore.createSession',
  'sessionStore.createSessionExact',
  'sessionStore.updateSession',
  'sessionStore.closeSession',
  'sessionStore.reactivateClosedSession',
  'getActiveSessionsRegistry',
  'activeSessions.set',
  'activeSessions.delete',
  'spawnDashboardSession',
  'forkWorker',
  'closeSession',
  'resumeSession',
  'transferSession',
  'suspendWorker',
  'killWorker',
  'activateQueuedSession',
  'repinSessionWorkingDir',
  'syncCurrentSessionWorkingDir',
  'sendWorkerSessionInput',
  'requestAgentSessionRename',
  'updateSessionTitle',
];

// Every IPC route is forbidden from directly acquiring a Session write
// capability. The reviewed C2 caller cut additionally forbids the read-only
// registry lookup above so those routes cannot sidestep their Runtime target.
const mandatoryIpcRouteForbiddenDirectWriteCalls =
  mandatoryControlForbiddenCallerCalls.filter(call => call !== 'getActiveSessionsRegistry');

const mandatorySharedRouteAdmissionConsumers = new Map([
  ['src/core/current-ordinary-route-registry.ts#createCurrentOrdinaryRouteRegistryRuntime', 3],
  ['src/core/current-reopen-route-admission.ts#createCurrentReopenRouteAdmissionPort', 1],
  ['src/core/current-scheduled-fire.ts#createCurrentScheduledFireAdapter', 2],
  ['src/core/trigger-session.ts#triggerSessionTurnAdmitted', 1],
]);

const mandatoryDashboardControlAuthoritySelectors = new Map([
  ['src/core/current-dashboard-route-opening.ts', ['inspectCurrentDashboardRoute']],
  ['src/core/current-ordinary-route-registry.ts', ['inspectRelocationTarget']],
  ['src/core/current-session-control.ts', ['convergeAsyncTriggerFault', 'execute']],
  ['src/core/session-manager.ts', ['spawnDashboardSession']],
]);

const mandatoryRemainingControlBypassSelectors = new Map([
  ['src/core/command-handler.ts', [
    'commitRepoSelection',
    'handleCardCommand',
    'handleCommand',
  ]],
  ['src/im/lark/card-handler.ts', ['commitRepoSelection', 'handleCardAction']],
  ['src/core/session-cwd.ts', ['assignWorkingDirectory', 'repinSessionWorkingDir']],
  ['src/core/session-title.ts', ['updateSessionTitle']],
]);

const mandatoryOrdinaryCallers = new Map([
  ['src/daemon.ts#handleNewTopicAdmitted', { sessionSubmitCount: 0, routeSubmitCount: 1 }],
  ['src/daemon.ts#handleThreadReplyAdmitted', { sessionSubmitCount: 1, routeSubmitCount: 1 }],
]);

const mandatoryPendingRepoCallerCuts = new Map([
  ['src/core/command-handler.ts#completePendingRepo', {
    submissionMode: 'injected-or-production',
    guardedByPendingRepo: false,
  }],
  ['src/im/lark/card-handler.ts#commitRepoSelection', {
    submissionMode: 'injected-or-production',
    guardedByPendingRepo: true,
  }],
  ['src/im/lark/card-handler.ts#runAutoWorktreeCommit', {
    submissionMode: 'injected-or-production',
    guardedByPendingRepo: false,
  }],
  ['src/im/lark/card-handler.ts#handleCardAction', {
    submissionMode: 'injected-or-production',
    guardedByPendingRepo: true,
  }],
  ['src/daemon.ts#runCurrentOrdinaryOpeningPostCommit', {
    submissionMode: 'production-direct',
    guardedByPendingRepo: false,
  }],
]);

const mandatoryForbiddenLegacyOrdinaryIdentifiers = [
  'PreparedThreadReply',
  'tryAcquireInitialStartClaim',
  'stageCurrentBehindQueuedActivation',
  'queuedHasDurableTail',
  'forkPendingCli',
];

const mandatoryForbiddenOrdinaryCallerCalls = [
  'forkWorker',
  'forkSession',
  'forkReservedInitialSession',
  'forkReservedInitialRawSession',
  'sendWorkerInput',
  'deliverPassthroughToExistingSession',
  'reserveAsyncQueuedActivationTailAdmission',
  'settleAsyncQueuedActivationTailAdmission',
  'stageClaimedPendingRepoSetup',
  'commitRepoSelection',
  'forkPendingCli',
];

const mandatorySessionLaneDeferredPaths = new Map([
  ['keyed-route-admission-and-fail-close', {
    targetMilestone: 'Target-A',
    sourceFile: 'src/core/current-keyed-trigger-turn.ts',
    enclosingFunction: 'failClose',
  }],
  ['activation-provider-effect-outside-lane', {
    targetMilestone: 'A4',
    sourceFile: 'src/core/worker-pool.ts',
    enclosingFunction: 'forkWorker',
  }],
]);

let cachedFacts;
const parsedSources = new Map();
let activeSourceOverrides;
let activeOverrideParsedSources;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function siteIdentity(site) {
  return `${site.sourceFile}#${site.enclosingFunction}`
    + ` :: ${site.receiverKind}.${site.fieldPath}`
    + ` :: ${site.operation}`
    + ` :: ${site.normalizedAstHash}`;
}

function selectedSiteFacts(sites) {
  const records = [...sites].sort((left, right) => siteIdentity(left).localeCompare(siteIdentity(right)));
  return {
    recordCount: records.length,
    mutationCount: records.reduce((sum, site) => sum + site.count, 0),
    digest: sha256(records.map(site => `${siteIdentity(site)} :: ${site.count}`).join('\0')),
  };
}

function rawPublisherIdentity(writer) {
  return `${writer.sourceFile}#${writer.enclosingFunction}`
    + ` :: ${writer.authorityId}`
    + ` :: ${writer.siteCount}`
    + ` :: ${writer.siteDigest}`
    + ` :: ${writer.functionDigest}`;
}

function selectedRawPublisherFacts(writers) {
  const records = [...writers].sort((left, right) => (
    rawPublisherIdentity(left).localeCompare(rawPublisherIdentity(right))
  ));
  return {
    recordCount: records.length,
    publishSiteCount: records.reduce((sum, writer) => sum + writer.siteCount, 0),
    digest: sha256(records.map(rawPublisherIdentity).join('\0')),
  };
}

function loadFacts() {
  if (cachedFacts) return cachedFacts;
  // `build` runs the source census first. This audit binds every coverage claim
  // to that reviewed snapshot instead of running a second, divergent scanner.
  const authorityRaw = readFileSync(authorityInventoryPath, 'utf8');
  const authorityInventory = JSON.parse(authorityRaw);
  cachedFacts = {
    authorityRaw,
    authorityInventory,
    sites: authorityInventory.mutationSites,
    rawPublishers: authorityInventory.scanner.rawSessionFileWriters,
    authorityClassifications: new Map(
      authorityInventory.authorities.map(authority => [authority.id, authority.classification]),
    ),
  };
  return cachedFacts;
}

function validateStringArray(value, label, { allowEmpty = false } = {}) {
  assert(Array.isArray(value), `${label} must be an array`);
  assert(allowEmpty || value.length > 0, `${label} must not be empty`);
  const seen = new Set();
  for (const item of value) {
    assert(typeof item === 'string' && item.length > 0, `${label} must contain non-empty strings`);
    assert(!seen.has(item), `${label} contains duplicate value: ${item}`);
    seen.add(item);
  }
}

function validateLedgerSchema(ledger) {
  assert(isPlainObject(ledger), 'SessionRuntime coverage ledger must be an object');
  assert(ledger.schemaVersion === 1, 'unsupported SessionRuntime coverage schemaVersion');
  assert(isPlainObject(ledger.authorityInventory), 'authorityInventory must be an object');
  assert(
    ledger.authorityInventory.path === authorityInventoryRelativePath,
    `authorityInventory.path must be ${authorityInventoryRelativePath}`,
  );
  assert(
    typeof ledger.authorityInventory.sha256 === 'string'
      && /^[a-f0-9]{64}$/.test(ledger.authorityInventory.sha256),
    'authorityInventory.sha256 must be a SHA-256 digest',
  );
  assert(Array.isArray(ledger.coverage), 'coverage must be an array');
  assert(ledger.coverage.length === expectedCoverage.size, 'coverage must contain every required path');

  const ids = new Set();
  for (const entry of ledger.coverage) {
    assert(isPlainObject(entry), 'each coverage entry must be an object');
    assert(typeof entry.id === 'string' && entry.id.length > 0, 'coverage entry id must be non-empty');
    assert(!ids.has(entry.id), `duplicate coverage entry id: ${entry.id}`);
    ids.add(entry.id);
    const expected = expectedCoverage.get(entry.id);
    assert(expected, `unknown coverage entry id: ${entry.id}`);
    assert(
      Object.prototype.hasOwnProperty.call(entry, 'targetMilestone'),
      `${entry.id}.targetMilestone is required`,
    );
    assert(
      entry.targetMilestone === expected.targetMilestone,
      `${entry.id}.targetMilestone must be ${expected.targetMilestone ?? 'null'}`,
    );
    assert(
      entry.disposition === expected.disposition,
      `${entry.id}.disposition must be ${expected.disposition}`,
    );
    assert(typeof entry.description === 'string' && entry.description.length > 0, `${entry.id}.description is required`);
    const zeroSiteEntry = entry.id === 'current-session-store-adapter'
      || entry.id === 'per-session-command-lane';
    assert(Array.isArray(entry.selectors), `${entry.id}.selectors must be an array`);
    assert(
      zeroSiteEntry ? entry.selectors.length === 0 : entry.selectors.length > 0,
      zeroSiteEntry
        ? `${entry.id}.selectors must stay empty because this entry binds structural evidence only`
        : `${entry.id}.selectors must not be empty`,
    );
    assert(isPlainObject(entry.authoritySites), `${entry.id}.authoritySites must be an object`);
    assert(
      Number.isInteger(entry.authoritySites.recordCount)
        && (zeroSiteEntry
          ? entry.authoritySites.recordCount === 0
          : entry.authoritySites.recordCount > 0),
      `${entry.id}.authoritySites.recordCount must be ${zeroSiteEntry ? 'zero' : 'positive'}`,
    );
    assert(
      Number.isInteger(entry.authoritySites.mutationCount)
        && (zeroSiteEntry
          ? entry.authoritySites.mutationCount === 0
          : entry.authoritySites.mutationCount > 0),
      `${entry.id}.authoritySites.mutationCount must be ${zeroSiteEntry ? 'zero' : 'positive'}`,
    );
    assert(
      typeof entry.authoritySites.digest === 'string'
        && /^[a-f0-9]{64}$/.test(entry.authoritySites.digest),
      `${entry.id}.authoritySites.digest must be a SHA-256 digest`,
    );
    for (const selector of entry.selectors) validateSelectorSchema(selector, entry.id);

    const bindsRawPublishers = entry.id === 'current-session-store-adapter'
      || entry.id === 'ordinary-im'
      || entry.id === 'path-specific-retained'
      || entry.id === 'remaining-bypass';
    if (bindsRawPublishers) {
      assert(
        Array.isArray(entry.rawPublisherSelectors) && entry.rawPublisherSelectors.length > 0,
        `${entry.id}.rawPublisherSelectors must not be empty`,
      );
      for (const selector of entry.rawPublisherSelectors) {
        validateRawPublisherSelectorSchema(selector, entry.id);
      }
      assert(isPlainObject(entry.authorityRawPublishers), `${entry.id}.authorityRawPublishers must be an object`);
      assert(
        Number.isInteger(entry.authorityRawPublishers.recordCount)
          && entry.authorityRawPublishers.recordCount > 0,
        `${entry.id}.authorityRawPublishers.recordCount must be positive`,
      );
      assert(
        Number.isInteger(entry.authorityRawPublishers.publishSiteCount)
          && entry.authorityRawPublishers.publishSiteCount > 0,
        `${entry.id}.authorityRawPublishers.publishSiteCount must be positive`,
      );
      assert(
        typeof entry.authorityRawPublishers.digest === 'string'
          && /^[a-f0-9]{64}$/.test(entry.authorityRawPublishers.digest),
        `${entry.id}.authorityRawPublishers.digest must be a SHA-256 digest`,
      );
    } else {
      assert(entry.rawPublisherSelectors === undefined, `${entry.id} must not select raw Session publishers`);
      assert(entry.authorityRawPublishers === undefined, `${entry.id} must not bind raw Session publishers`);
    }
  }
  for (const id of expectedCoverage.keys()) assert(ids.has(id), `missing coverage entry: ${id}`);

  const keyedTrigger = ledger.coverage.find(entry => entry.id === 'keyed-trigger-start');
  validateKeyedProductionBindingSchema(keyedTrigger.productionBinding);
  const ordinary = ledger.coverage.find(entry => entry.id === 'ordinary-im');
  validateOrdinaryProductionBindingSchema(ordinary.productionBinding);
  const dashboardControl = ledger.coverage.find(entry => entry.id === 'dashboard-control');
  validateDashboardControlAuthoritySelectors(dashboardControl.selectors);
  validateControlProductionBindingSchema(dashboardControl.productionBinding);
  const remainingControl = ledger.coverage.find(
    entry => entry.id === 'remaining-control-bypass',
  );
  validateRemainingControlBypassSelectors(remainingControl.selectors);
  const executor = ledger.coverage.find(entry => entry.id === 'executor-generation');
  validateExecutorSelectors(executor.selectors);
  validateExecutorProductionBindingSchema(executor.productionBinding);
  const sessionLane = ledger.coverage.find(entry => entry.id === 'per-session-command-lane');
  validateSessionLaneProductionBindingSchema(sessionLane.productionBinding);
  const scheduler = ledger.coverage.find(entry => entry.id === 'scheduler');
  validateSchedulerProductionBindingSchema(scheduler.productionBinding);
  const activation = ledger.coverage.find(entry => entry.id === 'activation-restore');
  validateActivationTailAuthoritySelector(activation.selectors);
  validateActivationProductionBindingSchema(activation.productionBinding);
  const projection = ledger.coverage.find(entry => entry.id === 'projection');
  validateProjectionProductionBindingSchema(projection.productionBinding);
  for (const entry of ledger.coverage) {
    if (entry.id !== 'keyed-trigger-start'
      && entry.id !== 'ordinary-im'
      && entry.id !== 'dashboard-control'
      && entry.id !== 'executor-generation'
      && entry.id !== 'per-session-command-lane'
      && entry.id !== 'projection'
      && entry.id !== 'scheduler'
      && entry.id !== 'activation-restore') {
      assert(entry.productionBinding === undefined, `${entry.id} must not claim a migrated production binding`);
    }
  }
}

function validateControlProductionBindingSchema(binding) {
  assert(isPlainObject(binding), 'dashboard-control.productionBinding must be an object');
  const allowedKeys = new Set([
    ...Object.keys(mandatoryControlProductionBinding),
    'routes',
    'forbiddenCallerCalls',
    'sharedRouteAdmissionConsumers',
  ]);
  for (const key of Object.keys(binding)) {
    assert(allowedKeys.has(key), `dashboard-control.productionBinding has unsupported field: ${key}`);
  }
  for (const [field, expected] of Object.entries(mandatoryControlProductionBinding)) {
    assert(
      binding[field] === expected,
      `dashboard-control.productionBinding.${field} must be ${expected}`,
    );
  }

  assert(
    Array.isArray(binding.routes) && binding.routes.length === mandatoryControlRoutes.size,
    'dashboard-control.productionBinding.routes must cover every reviewed Dashboard mutation route',
  );
  const seenRoutes = new Set();
  for (const route of binding.routes) {
    assert(isPlainObject(route), 'dashboard-control.productionBinding route must be an object');
    assert(
      typeof route.method === 'string' && typeof route.path === 'string',
      'dashboard-control.productionBinding route method/path are required',
    );
    const routeKey = `${route.method} ${route.path}`;
    assert(!seenRoutes.has(routeKey), `dashboard-control.productionBinding duplicates route ${routeKey}`);
    seenRoutes.add(routeKey);
    const expected = mandatoryControlRoutes.get(routeKey);
    assert(expected, `dashboard-control.productionBinding has unknown Dashboard route ${routeKey}`);
    assert(
      sameStringSet(Object.keys(route), ['method', 'path', ...Object.keys(expected)]),
      `dashboard-control.productionBinding route ${routeKey} must keep the exact reviewed fields`,
    );
    for (const [field, value] of Object.entries(expected)) {
      assert(
        route[field] === value,
        `dashboard-control.productionBinding route ${routeKey}.${field} must be ${value}`,
      );
    }
  }
  for (const routeKey of mandatoryControlRoutes.keys()) {
    assert(
      seenRoutes.has(routeKey),
      `dashboard-control.productionBinding.routes must include ${routeKey}`,
    );
  }

  validateStringArray(
    binding.forbiddenCallerCalls,
    'dashboard-control.productionBinding.forbiddenCallerCalls',
  );
  assert(
    sameStringSet(binding.forbiddenCallerCalls, mandatoryControlForbiddenCallerCalls),
    'dashboard-control.productionBinding.forbiddenCallerCalls must keep the exact direct Current capability fence',
  );

  assert(
    Array.isArray(binding.sharedRouteAdmissionConsumers)
      && binding.sharedRouteAdmissionConsumers.length === mandatorySharedRouteAdmissionConsumers.size,
    'dashboard-control.productionBinding.sharedRouteAdmissionConsumers must cover every reviewed route producer',
  );
  const seenConsumers = new Set();
  for (const consumer of binding.sharedRouteAdmissionConsumers) {
    assert(
      isPlainObject(consumer)
        && sameStringSet(
          Object.keys(consumer),
          ['sourceFile', 'enclosingFunction', 'reservationCount'],
        ),
      'dashboard-control.productionBinding shared route-admission consumer has unsupported fields',
    );
    const key = `${consumer.sourceFile}#${consumer.enclosingFunction}`;
    assert(
      !seenConsumers.has(key),
      `dashboard-control.productionBinding duplicates route-admission consumer ${key}`,
    );
    seenConsumers.add(key);
    const expected = mandatorySharedRouteAdmissionConsumers.get(key);
    assert(
      expected !== undefined,
      `dashboard-control.productionBinding has unknown route-admission consumer ${key}`,
    );
    assert(
      consumer.reservationCount === expected,
      `dashboard-control.productionBinding ${key}.reservationCount must be ${expected}`,
    );
  }
  for (const key of mandatorySharedRouteAdmissionConsumers.keys()) {
    assert(
      seenConsumers.has(key),
      `dashboard-control.productionBinding.sharedRouteAdmissionConsumers must include ${key}`,
    );
  }
}

function validateActivationProductionBindingSchema(binding) {
  assert(isPlainObject(binding), 'activation-restore.productionBinding must be an object');
  const allowedKeys = new Set([
    ...Object.keys(mandatoryActivationProductionBinding),
    'callerCuts',
    'retainedDirectCallClasses',
    'reviewedLegacyPartition',
  ]);
  for (const key of Object.keys(binding)) {
    assert(allowedKeys.has(key), `activation-restore.productionBinding has unsupported field: ${key}`);
  }
  for (const [field, expected] of Object.entries(mandatoryActivationProductionBinding)) {
    assert(
      binding[field] === expected,
      `activation-restore.productionBinding.${field} must be ${expected}`,
    );
  }
  assert(
    Array.isArray(binding.callerCuts)
      && binding.callerCuts.length === mandatoryActivationCallerCuts.size,
    'activation-restore.productionBinding.callerCuts must cover every reviewed activation caller',
  );
  const seen = new Set();
  for (const cut of binding.callerCuts) {
    assert(isPlainObject(cut), 'activation-restore.productionBinding caller cut must be an object');
    assert(
      sameStringSet(Object.keys(cut), ['sourceFile', 'enclosingFunction', 'coordinatorCall']),
      'activation-restore.productionBinding caller cut has unsupported fields',
    );
    const key = `${cut.sourceFile}#${cut.enclosingFunction}`;
    assert(!seen.has(key), `activation-restore.productionBinding duplicates caller ${key}`);
    seen.add(key);
    const expectedCall = mandatoryActivationCallerCuts.get(key);
    assert(expectedCall, `activation-restore.productionBinding has unknown caller ${key}`);
    assert(
      cut.coordinatorCall === expectedCall,
      `activation-restore.productionBinding ${key}.coordinatorCall must be ${expectedCall}`,
    );
  }
  for (const key of mandatoryActivationCallerCuts.keys()) {
    assert(seen.has(key), `activation-restore.productionBinding must include ${key}`);
  }
  validateStringArray(
    binding.retainedDirectCallClasses,
    'activation-restore.productionBinding.retainedDirectCallClasses',
  );
  assert(
    sameStringSet(binding.retainedDirectCallClasses, [
      'fresh-session-creation',
      'generation-precommit-trigger',
      'provider-internal-recovery',
      'explicit-control-lifecycle',
    ]),
    'activation-restore.productionBinding.retainedDirectCallClasses must keep the exact reviewed non-A4 callers',
  );
  assert(
    isPlainObject(binding.reviewedLegacyPartition)
      && sameStringSet(
        Object.keys(binding.reviewedLegacyPartition),
        Object.keys(mandatoryActivationLegacyPartition),
      ),
    'activation-restore.productionBinding.reviewedLegacyPartition must keep the exact 343-site split',
  );
  for (const [field, expected] of Object.entries(mandatoryActivationLegacyPartition)) {
    assert(
      binding.reviewedLegacyPartition[field] === expected,
      `activation-restore.productionBinding.reviewedLegacyPartition.${field} must be ${expected}`,
    );
  }
}

function validateProjectionProductionBindingSchema(binding) {
  assert(isPlainObject(binding), 'projection.productionBinding must be an object');
  assert(
    sameStringSet(Object.keys(binding), Object.keys(mandatoryProjectionProductionBinding)),
    'projection.productionBinding must name only the reviewed C3 sources',
  );
  for (const [field, expected] of Object.entries(mandatoryProjectionProductionBinding)) {
    assert(
      binding[field] === expected,
      `projection.productionBinding.${field} must be ${expected}`,
    );
  }
}

function validateSchedulerProductionBindingSchema(binding) {
  assert(isPlainObject(binding), 'scheduler.productionBinding must be an object');
  const allowedKeys = new Set([
    ...Object.keys(mandatorySchedulerProductionBinding),
    'forbiddenProducerCalls',
  ]);
  for (const key of Object.keys(binding)) {
    assert(allowedKeys.has(key), `scheduler.productionBinding has unsupported field: ${key}`);
  }
  for (const [field, expected] of Object.entries(mandatorySchedulerProductionBinding)) {
    assert(
      binding[field] === expected,
      `scheduler.productionBinding.${field} must be ${expected}`,
    );
  }
  validateStringArray(
    binding.forbiddenProducerCalls,
    'scheduler.productionBinding.forbiddenProducerCalls',
  );
  assert(
    sameStringSet(
      binding.forbiddenProducerCalls,
      mandatorySchedulerForbiddenProducerCalls,
    ),
    'scheduler.productionBinding.forbiddenProducerCalls must cover the exact direct Session capabilities',
  );
}

function validateRawPublisherSelectorSchema(selector, entryId) {
  assert(isPlainObject(selector), `${entryId} raw publisher selector must be an object`);
  if (selector.inventoryRemainder === true) {
    const allowedKeys = new Set(['inventoryRemainder', 'authorityClassifications']);
    for (const key of Object.keys(selector)) {
      assert(allowedKeys.has(key), `${entryId} raw publisher remainder has unsupported field: ${key}`);
    }
    assert(
      entryId === 'path-specific-retained' || entryId === 'remaining-bypass',
      'only path-specific-retained or remaining-bypass may select the raw publisher remainder',
    );
    if (entryId === 'path-specific-retained') {
      validateStringArray(
        selector.authorityClassifications,
        `${entryId} raw publisher selector.authorityClassifications`,
      );
      assert(
        selector.authorityClassifications.length === 1
          && selector.authorityClassifications[0] === 'path_specific_authority',
        `${entryId} raw publisher remainder must select only path_specific_authority`,
      );
    } else {
      assert(
        Object.keys(selector).length === 1,
        `${entryId} raw publisher remainder must be the final unfiltered bypass remainder`,
      );
    }
    return;
  }
  const allowedKeys = new Set(['sourceFile', 'enclosingFunctions', 'authorityIds']);
  for (const key of Object.keys(selector)) {
    assert(allowedKeys.has(key), `${entryId} raw publisher selector has unsupported field: ${key}`);
  }
  assert(
    typeof selector.sourceFile === 'string' && selector.sourceFile.startsWith('src/'),
    `${entryId} raw publisher selector.sourceFile must name src/`,
  );
  if (selector.enclosingFunctions !== undefined) {
    validateStringArray(selector.enclosingFunctions, `${entryId} raw publisher selector.enclosingFunctions`);
  }
  if (selector.authorityIds !== undefined) {
    validateStringArray(selector.authorityIds, `${entryId} raw publisher selector.authorityIds`);
  }
}

function validateSelectorSchema(selector, entryId) {
  assert(isPlainObject(selector), `${entryId} selector must be an object`);
  if (selector.inventoryRemainder === true) {
    const allowedKeys = new Set(['inventoryRemainder', 'classifications', 'excludedAccessLanes']);
    for (const key of Object.keys(selector)) {
      assert(allowedKeys.has(key), `${entryId} inventory remainder has unsupported field: ${key}`);
    }
    assert(
      entryId === 'path-specific-retained'
        || entryId === 'projection'
        || entryId === 'remaining-bypass',
      'only the explicit retained/projection/bypass partitions may select the inventory remainder',
    );
    if (entryId === 'path-specific-retained') {
      validateStringArray(selector.classifications, `${entryId} selector.classifications`);
      validateStringArray(selector.excludedAccessLanes, `${entryId} selector.excludedAccessLanes`);
      assert(
        selector.classifications.length === 1
          && selector.classifications[0] === 'path_specific_authority',
        `${entryId} remainder must select only path_specific_authority`,
      );
      for (const lane of retainedForbiddenAccessLanes) {
        assert(
          selector.excludedAccessLanes.includes(lane),
          `${entryId} remainder must exclude ${lane}`,
        );
      }
    } else if (entryId === 'projection') {
      validateStringArray(selector.classifications, `${entryId} selector.classifications`);
      assert(
        selector.classifications.length === 1 && selector.classifications[0] === 'projection',
        'projection remainder must select only projection sites',
      );
      assert(
        selector.excludedAccessLanes === undefined,
        'projection remainder must not carry access-lane exclusions',
      );
    } else {
      assert(
        Object.keys(selector).length === 1,
        'remaining-bypass must be the final unfiltered inventory remainder',
      );
    }
    return;
  }
  const allowedKeys = new Set(['sourceFile', 'enclosingFunctions', 'accessLanes', 'authorityIds']);
  for (const key of Object.keys(selector)) {
    assert(allowedKeys.has(key), `${entryId} selector has unsupported field: ${key}`);
  }
  assert(typeof selector.sourceFile === 'string' && selector.sourceFile.startsWith('src/'), `${entryId} selector.sourceFile must name src/`);
  if (selector.enclosingFunctions !== undefined) {
    validateStringArray(selector.enclosingFunctions, `${entryId} selector.enclosingFunctions`);
  }
  if (selector.accessLanes !== undefined) {
    validateStringArray(selector.accessLanes, `${entryId} selector.accessLanes`);
  }
  if (selector.authorityIds !== undefined) {
    validateStringArray(selector.authorityIds, `${entryId} selector.authorityIds`);
  }
}

function validateKeyedProductionBindingSchema(binding) {
  assert(isPlainObject(binding), 'keyed-trigger-start.productionBinding must be an object');
  assert(typeof binding.sourceFile === 'string' && binding.sourceFile.startsWith('src/'), 'productionBinding.sourceFile must name src/');
  assert(typeof binding.enclosingFunction === 'string' && binding.enclosingFunction.length > 0, 'productionBinding.enclosingFunction is required');
  assert(binding.runtimeMethod === 'submit', 'productionBinding.runtimeMethod must be submit');
  assert(binding.commandKind === 'keyedTrigger.start', 'productionBinding.commandKind must be keyedTrigger.start');
  assert(binding.scope === 'nearestIf', 'productionBinding.scope must be nearestIf');
  validateStringArray(binding.forbiddenCalls, 'productionBinding.forbiddenCalls');
  validateStringArray(binding.pureRuntimeSources, 'productionBinding.pureRuntimeSources');
  validateStringArray(binding.forbiddenImports, 'productionBinding.forbiddenImports');
  for (const call of mandatoryForbiddenCalls) {
    assert(binding.forbiddenCalls.includes(call), `productionBinding.forbiddenCalls must include ${call}`);
  }
  for (const path of mandatoryPureRuntimeSources) {
    assert(binding.pureRuntimeSources.includes(path), `productionBinding.pureRuntimeSources must include ${path}`);
  }
  for (const path of mandatoryForbiddenImports) {
    assert(binding.forbiddenImports.includes(path), `productionBinding.forbiddenImports must include ${path}`);
  }
}

function sameStringSet(actual, expected) {
  return actual.length === expected.length
    && actual.every(value => expected.includes(value));
}

function validateExactFunctionSelectors(
  entryId,
  selectors,
  expectedSelectors,
  { accessLane } = {},
) {
  assert(
    selectors.length === expectedSelectors.size,
    `${entryId} selectors must remain the exact reviewed authority partition`,
  );
  const seen = new Set();
  for (const selector of selectors) {
    const expectedFunctions = expectedSelectors.get(selector.sourceFile);
    assert(
      expectedFunctions,
      `${entryId} selectors must remain the exact reviewed authority partition: ${selector.sourceFile}`,
    );
    assert(
      !seen.has(selector.sourceFile),
      `${entryId} selectors duplicate exact reviewed source: ${selector.sourceFile}`,
    );
    seen.add(selector.sourceFile);
    assert(
      sameStringSet(selector.enclosingFunctions ?? [], expectedFunctions),
      `${entryId} selectors must name only exact reviewed functions: ${selector.sourceFile}`,
    );
    assert(
      accessLane === undefined
        ? selector.accessLanes === undefined
        : sameStringSet(selector.accessLanes ?? [], [accessLane]),
      accessLane === undefined
        ? `${entryId} selectors must not widen through an access lane: ${selector.sourceFile}`
        : `${entryId} selectors must use only the exact ${accessLane} access lane: ${selector.sourceFile}`,
    );
    assert(
      selector.authorityIds === undefined,
      `${entryId} selectors must not widen through authority IDs: ${selector.sourceFile}`,
    );
  }
  for (const source of expectedSelectors.keys()) {
    assert(
      seen.has(source),
      `${entryId} selectors must remain the exact reviewed authority partition: ${source}`,
    );
  }
}

function validateDashboardControlAuthoritySelectors(selectors) {
  validateExactFunctionSelectors(
    'dashboard-control',
    selectors,
    mandatoryDashboardControlAuthoritySelectors,
    { accessLane: 'session-runtime-current-adapter' },
  );
}

function validateRemainingControlBypassSelectors(selectors) {
  validateExactFunctionSelectors(
    'remaining-control-bypass',
    selectors,
    mandatoryRemainingControlBypassSelectors,
  );
}

function validateOrdinaryAuthoritySelectors(selectors) {
  assert(
    selectors.length === mandatoryOrdinaryAuthoritySelectors.size,
    'ordinary-im selectors must remain the exact Current authority partition',
  );
  const seen = new Set();
  for (const selector of selectors) {
    const expectedFunctions = mandatoryOrdinaryAuthoritySelectors.get(selector.sourceFile);
    assert(
      expectedFunctions,
      `ordinary-im selectors must remain the exact Current authority partition: ${selector.sourceFile}`,
    );
    assert(
      !seen.has(selector.sourceFile),
      `ordinary-im selectors duplicate exact Current authority source: ${selector.sourceFile}`,
    );
    seen.add(selector.sourceFile);
    assert(
      sameStringSet(selector.enclosingFunctions ?? [], expectedFunctions),
      `ordinary-im selectors must remain the exact Current authority partition: ${selector.sourceFile}`,
    );
    assert(
      sameStringSet(selector.accessLanes ?? [], ['session-runtime-current-adapter']),
      `ordinary-im selectors must use only the exact Current authority access lane: ${selector.sourceFile}`,
    );
    assert(
      selector.authorityIds === undefined,
      `ordinary-im selectors must not widen through authority IDs: ${selector.sourceFile}`,
    );
  }
  for (const source of mandatoryOrdinaryAuthoritySelectors.keys()) {
    assert(
      seen.has(source),
      `ordinary-im selectors must remain the exact Current authority partition: ${source}`,
    );
  }
}

function validateActivationTailAuthoritySelector(selectors) {
  const expected = mandatoryActivationTailAuthoritySelector;
  const candidates = selectors.filter(selector => (
    selector.sourceFile === expected.sourceFile
    && selector.enclosingFunctions?.some(fn => expected.enclosingFunctions.includes(fn))
  ));
  assert(
    candidates.length === 1,
    'activation-restore must keep one exact typed tail authority selector',
  );
  const [selector] = candidates;
  assert(
    sameStringSet(selector.enclosingFunctions ?? [], expected.enclosingFunctions)
      && selector.accessLanes === undefined
      && selector.authorityIds === undefined,
    'activation-restore must keep the exact typed tail authority selector',
  );
  assert(
    selectors.every(candidate => (
      !candidate.enclosingFunctions?.includes('promoteQueuedActivationTail')
    )),
    'activation-restore must not bind the obsolete untyped tail wrapper',
  );
}

function validateActivationProductionBinding(binding) {
  const runtimeSource = sourceFile(binding.runtimeSource);
  const runtimeFactory = findNamedFunction(runtimeSource, binding.runtimeFactory);
  const runtimeEnsure = findNamedFunction(runtimeFactory, 'ensure');
  assert(
    containsStringLiteral(runtimeEnsure, 'retryable')
      && callExpressionsWithin(runtimeEnsure, 'attempts.delete').length > 0,
    'A4 retryable activation must evict its process-local terminal cache entry',
  );
  assert(
    containsStringLiteral(runtimeEnsure, 'joined')
      && containsStringLiteral(runtimeEnsure, 'completed')
      && containsIdentifier(runtimeEnsure, 'state'),
    'A4 duplicate activation must report joined versus completed state accurately',
  );
  assert(
    containsIdentifier(runtimeFactory, 'lifecycleRevision')
      && callExpressionsWithin(runtimeFactory, 'commandLane.submit').length > 0,
    'A4 activation and retirement must share the owner-scoped Session lane',
  );

  const adapterSource = sourceFile(binding.currentAdapterSource);
  const adapterFactory = findNamedFunction(adapterSource, binding.currentAdapterFactory);
  const quarantineFor = findNamedFunction(adapterFactory, 'quarantineFor');
  const adapterBegin = findNamedFunction(adapterFactory, 'begin');
  const adapterExecute = findNamedFunction(adapterFactory, 'execute');
  const adapterRetire = findNamedFunction(adapterFactory, 'retire');
  const adapterSettleRetirement = findNamedFunction(adapterFactory, 'settleRetirement');
  assert(
    containsIdentifier(adapterExecute, binding.managedProvider)
      && containsIdentifier(adapterExecute, binding.adoptProvider),
    'A4 Current Adapter must preserve managed and adopt provider protocols behind one seam',
  );
  assert(
    callExpressionsWithin(quarantineFor, 'quarantines.set').length === 1
      && containsIdentifier(quarantineFor, 'backendUnknown')
      && containsIdentifier(quarantineFor, 'pendingRetirements'),
    'A4 backend quarantine must bind unknown evidence and pending retirements to one exact Current binding',
  );
  assert(
    containsStringLiteral(adapterBegin, 'reconcile')
      && containsStringLiteral(adapterBegin, 'unknown')
      && propertyAccessExpressionsWithin(adapterBegin, 'request', 'goal').length > 0
      && propertyAccessExpressionsWithin(adapterBegin, 'quarantined', 'backendUnknown').length > 0
      && propertyAccessExpressionsWithin(adapterBegin, 'quarantined', 'pendingRetirements').length > 0
      && propertyAssignmentsWithin(
        adapterBegin,
        'quarantined',
        'backendUnknown',
        ts.SyntaxKind.FalseKeyword,
      ).length === 1
      && callExpressionsWithin(adapterBegin, 'quarantines.delete').length === 1,
    'A4 unknown backend evidence must stay quarantined until one typed exists/missing re-probe',
  );
  assert(
    callExpressionsWithin(adapterRetire, 'quarantineFor').length === 1
      && callExpressionsWithin(adapterRetire, 'pendingRetirements.add').length === 1
      && callExpressionsWithin(adapterRetire, 'quarantines.delete').length === 0
      && propertyAssignmentsWithin(
        adapterRetire,
        'quarantine',
        'backendUnknown',
        ts.SyntaxKind.FalseKeyword,
      ).length === 0,
    'A4 retirement prepare must publish its provider fence without clearing backend quarantine',
  );

  const appliedBranches = propertyLiteralIf(
    adapterSettleRetirement,
    'request',
    'disposition',
    'applied',
  );
  const notAppliedBranches = propertyLiteralIf(
    adapterSettleRetirement,
    'request',
    'disposition',
    'notApplied',
  );
  assert(
    appliedBranches.length === 1 && notAppliedBranches.length === 1,
    'A4 retirement settlement must distinguish applied from notApplied provider evidence',
  );
  const [appliedBranch] = appliedBranches;
  const [notAppliedBranch] = notAppliedBranches;
  const notAppliedCleanup = callExpressionsWithin(
    notAppliedBranch.thenStatement,
    'quarantines.delete',
  );
  const notAppliedCleanupGuard = notAppliedCleanup[0]
    ? ancestorWithin(notAppliedCleanup[0], notAppliedBranch.thenStatement, ts.isIfStatement)
    : undefined;
  const notAppliedGuardText = notAppliedCleanupGuard?.expression.getText(adapterSource) ?? '';
  assert(
    callExpressionsWithin(appliedBranch.thenStatement, 'quarantines.delete').length === 1
      && callExpressionsWithin(notAppliedBranch.thenStatement, 'pendingRetirements.delete').length === 1
      && notAppliedCleanup.length === 1
      && notAppliedGuardText.includes('!quarantine.backendUnknown')
      && notAppliedGuardText.includes('quarantine.pendingRetirements.size === 0'),
    'A4 notApplied settlement may clear only its pending fence and must preserve prior backend-unknown evidence',
  );
  const unknownSettlement = notAppliedBranch.elseStatement;
  assert(
    !!unknownSettlement
      && callExpressionsWithin(unknownSettlement, 'pendingRetirements.delete').length === 1
      && callExpressionsWithin(unknownSettlement, 'quarantines.delete').length === 0
      && propertyAssignmentsWithin(
        unknownSettlement,
        'quarantine',
        'backendUnknown',
        ts.SyntaxKind.TrueKeyword,
      ).length === 1
      && propertyAssignmentsWithin(
        adapterSettleRetirement,
        'retirement',
        'settlement',
      ).length === 1
      && propertyAccessExpressionsWithin(
        adapterSettleRetirement,
        'request',
        'disposition',
      ).length >= 4,
    'A4 unknown retirement settlement must remain sticky and bind one exact evidence receipt',
  );

  const coordinatorFactory = findNamedFunction(adapterSource, binding.coordinatorFactory);
  assert(
    containsIdentifier(coordinatorFactory, 'ownerBotId')
      && containsIdentifier(coordinatorFactory, 'runtimeEpoch')
      && callExpressionsWithin(coordinatorFactory, 'createCoordinator').length === 1,
    'A4 coordinator cache must bind the stable BotId and daemon epoch',
  );
  const createCoordinator = findNamedFunction(adapterSource, 'createCoordinator');
  assert(
    callExpressionsWithin(createCoordinator, binding.runtimeFactory).length === 1
      && containsIdentifier(createCoordinator, binding.sharedLaneExport)
      && callExpressionsWithin(createCoordinator, binding.laneAddressFactory).length === 1,
    'A4 coordinator must use the same Current owner/epoch Session lane',
  );

  const currentRuntimeSource = sourceFile(binding.currentRuntimeSource);
  const currentRuntimeFactory = findNamedFunction(
    currentRuntimeSource,
    binding.currentRuntimeFactory,
  );
  assert(
    callExpressionsWithin(currentRuntimeFactory, binding.coordinatorFactory).length === 1
      && callExpressionsWithin(currentRuntimeFactory, binding.laneAddressFactory).length === 1
      && containsIdentifier(currentRuntimeFactory, 'stableOwnerKey')
      && containsIdentifier(currentRuntimeFactory, 'runtimeEpoch'),
    'A4 and SessionRuntime must share one stable BotId/runtime-epoch lane directory',
  );

  const daemonSource = sourceFile(binding.daemonSource);
  const daemonFactory = findNamedFunction(daemonSource, binding.daemonFactory);
  assert(
    callExpressionsWithin(daemonFactory, binding.coordinatorFactory).length === 1
      && callExpressionsWithin(daemonFactory, 'requireBotId').length === 1
      && callExpressionsWithin(daemonFactory, 'getDaemonBootId').length === 1,
    'A4 daemon composition must inject one stable BotId + boot-epoch coordinator',
  );

  const providerSource = sourceFile(binding.providerSource);
  for (const symbol of [
    binding.managedProvider,
    binding.adoptProvider,
    binding.typedTailRecovery,
    binding.typedTailPromotion,
  ]) {
    findNamedFunction(providerSource, symbol);
  }

  for (const cut of binding.callerCuts) {
    const caller = findNamedFunction(sourceFile(cut.sourceFile), cut.enclosingFunction);
    assert(
      callExpressionsWithin(caller, cut.coordinatorCall).length > 0,
      `A4 caller ${cut.sourceFile}#${cut.enclosingFunction} must cross the coordinator seam`,
    );
    for (const forbidden of [binding.managedProvider, binding.adoptProvider]) {
      assert(
        callExpressionsWithin(caller, forbidden).length === 0,
        `A4 caller ${cut.sourceFile}#${cut.enclosingFunction} must not call ${forbidden} directly`,
      );
    }
  }

  const generationOracle = readFileSync(resolve(repoRoot, binding.generationOracle), 'utf8');
  const workerExitOracle = readFileSync(resolve(repoRoot, binding.workerExitOracle), 'utf8');
  const restoreOracle = readFileSync(resolve(repoRoot, binding.restoreOracle), 'utf8');
  const terminalOracle = readFileSync(resolve(repoRoot, binding.terminalOracle), 'utf8');
  assert(
    generationOracle.includes("kind: 'workerExit'")
      && workerExitOracle.includes("expect(ds.session.status).toBe('active')")
      && workerExitOracle.includes('expect(ds.worker).toBeNull()'),
    'A4 worker-exit oracle must keep the Session active while retiring only the executor',
  );
  assert(
    restoreOracle.includes('without closing, forking, or quarantining')
      && restoreOracle.includes('expect(restoreActivationRequests).toEqual([])'),
    'A4 restore oracle must keep an unknown probe recoverable: no close, no fork, and no activation quarantine',
  );
  assert(
    terminalOracle.includes('permits a later generation to wake again')
      && terminalOracle.includes('terminal:terminal-session:4'),
    'A4 terminal oracle must permit a later worker generation to reactivate',
  );
}

function validateExecutorSelectors(selectors) {
  assert(
    selectors.length === mandatoryExecutorSelectors.size,
    'executor-generation selectors must remain an exact production partition',
  );
  const seen = new Set();
  for (const selector of selectors) {
    const expectedFunctions = mandatoryExecutorSelectors.get(selector.sourceFile);
    assert(
      expectedFunctions,
      `executor-generation selector is not an exact reviewed source: ${selector.sourceFile}`,
    );
    assert(!seen.has(selector.sourceFile), `duplicate executor-generation selector: ${selector.sourceFile}`);
    seen.add(selector.sourceFile);
    assert(
      sameStringSet(selector.accessLanes ?? [], [executorRuntimeAccessLane]),
      `executor-generation selector ${selector.sourceFile} must use only the exact ${executorRuntimeAccessLane} access lane`,
    );
    assert(
      sameStringSet(selector.enclosingFunctions ?? [], expectedFunctions),
      `executor-generation selector ${selector.sourceFile} must name only its exact reviewed functions`,
    );
    assert(
      selector.authorityIds === undefined,
      `executor-generation selector ${selector.sourceFile} must not widen through authority IDs`,
    );
  }
}

function validateExecutorProductionBindingSchema(binding) {
  assert(isPlainObject(binding), 'executor-generation.productionBinding must be an object');
  for (const field of [
    'workerSource',
    'runtimeSource',
    'currentAdapterSource',
    'evidenceAdapterSource',
  ]) {
    assert(
      typeof binding[field] === 'string' && binding[field].startsWith('src/'),
      `executor-generation.productionBinding.${field} must name src/`,
    );
  }
  for (const field of ['handlerFunction', 'reservationFunction']) {
    assert(
      typeof binding[field] === 'string' && binding[field].length > 0,
      `executor-generation.productionBinding.${field} is required`,
    );
  }
  assert(
    binding.workerSource === 'src/core/worker-pool.ts',
    'executor-generation.productionBinding.workerSource must remain worker-pool',
  );
  assert(
    binding.handlerFunction === 'setupWorkerHandlers',
    'executor-generation.productionBinding.handlerFunction must remain setupWorkerHandlers',
  );
  assert(
    binding.reservationFunction === 'reserveWorkerGeneration',
    'executor-generation.productionBinding.reservationFunction must remain reserveWorkerGeneration',
  );
  assert(
    binding.runtimeSource === 'src/core/session-executor-runtime.ts',
    'executor-generation.productionBinding.runtimeSource must remain the pure internal Runtime',
  );
  assert(
    binding.currentAdapterSource === 'src/core/current-session-executor-runtime.ts',
    'executor-generation.productionBinding.currentAdapterSource must remain the Current generation Adapter',
  );
  assert(
    binding.evidenceAdapterSource === 'src/core/current-dispatch-input-commit-evidence.ts',
    'executor-generation.productionBinding.evidenceAdapterSource must remain the named evidence Adapter',
  );
  validateStringArray(
    binding.observationKinds,
    'executor-generation.productionBinding.observationKinds',
  );
  assert(
    sameStringSet(binding.observationKinds, mandatoryExecutorObservationKinds),
    'executor-generation.productionBinding.observationKinds must cover every executor observation',
  );
}

function validateOrdinaryNamedBindings(value, label, mandatory, valueFields) {
  assert(Array.isArray(value), `ordinary-im.productionBinding.${label} must be an array`);
  assert(
    value.length === mandatory.size,
    `ordinary-im.productionBinding.${label} must cover every ${label === 'ordinaryCallers' ? 'ordinary caller' : 'pending-repo first-start caller'}`,
  );
  const seen = new Set();
  for (const record of value) {
    assert(isPlainObject(record), `ordinary-im.productionBinding.${label} record must be an object`);
    const allowedKeys = new Set(['sourceFile', 'enclosingFunction', ...valueFields]);
    for (const key of Object.keys(record)) {
      assert(allowedKeys.has(key), `ordinary-im.productionBinding.${label} has unsupported field: ${key}`);
    }
    const key = `${record.sourceFile}#${record.enclosingFunction}`;
    assert(!seen.has(key), `ordinary-im.productionBinding.${label} duplicates ${key}`);
    seen.add(key);
    const expected = mandatory.get(key);
    assert(expected, `ordinary-im.productionBinding.${label} has unknown caller ${key}`);
    for (const [field, expectedValue] of Object.entries(expected)) {
      assert(
        record[field] === expectedValue,
        `ordinary-im.productionBinding.${label} ${key}.${field} must be ${expectedValue}`,
      );
    }
  }
  for (const key of mandatory.keys()) {
    assert(
      seen.has(key),
      `ordinary-im.productionBinding.${label} must include ${key.split('#')[1]}`,
    );
  }
}

function validateOrdinaryProductionBindingSchema(binding) {
  assert(isPlainObject(binding), 'ordinary-im.productionBinding must be an object');
  const allowedKeys = new Set([
    ...Object.keys(mandatoryOrdinaryProductionBinding),
    'ordinaryCallers',
    'pendingRepoCallerCuts',
    'forbiddenLegacyIdentifiers',
    'forbiddenOrdinaryCallerCalls',
  ]);
  for (const key of Object.keys(binding)) {
    assert(allowedKeys.has(key), `ordinary-im.productionBinding has unsupported field: ${key}`);
  }
  for (const [field, expected] of Object.entries(mandatoryOrdinaryProductionBinding)) {
    assert(
      binding[field] === expected,
      `ordinary-im.productionBinding.${field} must be ${expected}`,
    );
  }
  validateOrdinaryNamedBindings(
    binding.ordinaryCallers,
    'ordinaryCallers',
    mandatoryOrdinaryCallers,
    ['sessionSubmitCount', 'routeSubmitCount'],
  );
  validateOrdinaryNamedBindings(
    binding.pendingRepoCallerCuts,
    'pendingRepoCallerCuts',
    mandatoryPendingRepoCallerCuts,
    ['submissionMode', 'guardedByPendingRepo'],
  );
  validateStringArray(
    binding.forbiddenLegacyIdentifiers,
    'ordinary-im.productionBinding.forbiddenLegacyIdentifiers',
  );
  assert(
    sameStringSet(
      binding.forbiddenLegacyIdentifiers,
      mandatoryForbiddenLegacyOrdinaryIdentifiers,
    ),
    'ordinary-im.productionBinding.forbiddenLegacyIdentifiers must cover the exact legacy ordinary identifiers',
  );
  validateStringArray(
    binding.forbiddenOrdinaryCallerCalls,
    'ordinary-im.productionBinding.forbiddenOrdinaryCallerCalls',
  );
  assert(
    sameStringSet(
      binding.forbiddenOrdinaryCallerCalls,
      mandatoryForbiddenOrdinaryCallerCalls,
    ),
    'ordinary-im.productionBinding.forbiddenOrdinaryCallerCalls must cover every direct legacy ordinary call',
  );
}

function validateSessionLaneProductionBindingSchema(binding) {
  assert(isPlainObject(binding), 'per-session-command-lane.productionBinding must be an object');
  const allowedKeys = new Set([
    ...Object.keys(mandatorySessionLaneBinding),
    'observationKinds',
    'deferredPaths',
  ]);
  for (const key of Object.keys(binding)) {
    assert(allowedKeys.has(key), `per-session-command-lane.productionBinding has unsupported field: ${key}`);
  }
  for (const [field, expected] of Object.entries(mandatorySessionLaneBinding)) {
    if (field === 'currentLaneSource') {
      assert(
        binding[field] === expected,
        'per-session-command-lane.productionBinding.currentLaneSource must remain the shared Current lane module',
      );
    } else if (field === 'reportCallCount') {
      assert(
        binding[field] === expected,
        'per-session-command-lane.productionBinding.reportCallCount must cover the exact report routes',
      );
    } else if (field === 'resumeCallCount') {
      assert(
        binding[field] === expected,
        'per-session-command-lane.productionBinding.resumeCallCount must cover the exact continuation routes',
      );
    } else {
      assert(
        binding[field] === expected,
        `per-session-command-lane.productionBinding.${field} must be ${expected}`,
      );
    }
  }
  validateStringArray(
    binding.observationKinds,
    'per-session-command-lane.productionBinding.observationKinds',
  );
  assert(
    sameStringSet(binding.observationKinds, mandatoryExecutorObservationKinds),
    'per-session-command-lane.productionBinding.observationKinds must cover every executor observation',
  );
  assert(
    Array.isArray(binding.deferredPaths),
    'per-session-command-lane.productionBinding.deferredPaths must be an array',
  );
  assert(
    binding.deferredPaths.length === mandatorySessionLaneDeferredPaths.size,
    'per-session-command-lane.productionBinding.deferredPaths must include keyed fail-close and the A4 provider effect kept outside the lane',
  );
  const seen = new Set();
  for (const path of binding.deferredPaths) {
    assert(isPlainObject(path), 'per-session-command-lane deferred path must be an object');
    const allowedPathKeys = new Set(['id', 'targetMilestone', 'sourceFile', 'enclosingFunction']);
    for (const key of Object.keys(path)) {
      assert(allowedPathKeys.has(key), `per-session-command-lane deferred path has unsupported field: ${key}`);
    }
    assert(typeof path.id === 'string' && path.id.length > 0, 'per-session-command-lane deferred path id is required');
    assert(!seen.has(path.id), `duplicate per-session-command-lane deferred path: ${path.id}`);
    seen.add(path.id);
    const expected = mandatorySessionLaneDeferredPaths.get(path.id);
    assert(
      expected,
      `unknown per-session-command-lane deferred path: ${path.id}`,
    );
    for (const [field, value] of Object.entries(expected)) {
      assert(
        path[field] === value,
        `per-session-command-lane deferred path ${path.id}.${field} must be ${value}`,
      );
    }
  }
  for (const id of mandatorySessionLaneDeferredPaths.keys()) {
    assert(
      seen.has(id),
      `per-session-command-lane.productionBinding.deferredPaths must include ${id}`,
    );
  }
}

function selectAuthoritySites(selector, sites, assigned) {
  if (selector.inventoryRemainder === true) {
    return sites.filter(site => (
      !assigned.has(siteIdentity(site))
      && (!selector.classifications || selector.classifications.includes(site.classification))
      && (!selector.excludedAccessLanes
        || !selector.excludedAccessLanes.includes(site.accessLane))
    ));
  }
  const absolute = resolve(repoRoot, selector.sourceFile);
  assert(existsSync(absolute), `coverage selector source is missing: ${selector.sourceFile}`);
  const selected = sites.filter(site => (
    site.sourceFile === selector.sourceFile
    && (!selector.enclosingFunctions || selector.enclosingFunctions.includes(site.enclosingFunction))
    && (!selector.accessLanes || selector.accessLanes.includes(site.accessLane))
    && (!selector.authorityIds || selector.authorityIds.includes(site.authorityId))
  ));
  if (selector.enclosingFunctions) {
    for (const fn of selector.enclosingFunctions) {
      assert(
        selected.some(site => site.enclosingFunction === fn),
        `coverage selector matched no authority sites for missing symbol ${selector.sourceFile}#${fn}`,
      );
    }
  }
  if (selector.accessLanes) {
    for (const lane of selector.accessLanes) {
      assert(selected.some(site => site.accessLane === lane), `coverage selector matched no authority sites for access lane ${lane}`);
    }
  }
  if (selector.authorityIds) {
    for (const authorityId of selector.authorityIds) {
      assert(selected.some(site => site.authorityId === authorityId), `coverage selector matched no authority sites for authority ${authorityId}`);
    }
  }
  assert(selected.length > 0, `coverage selector matched no authority sites: ${selector.sourceFile}`);
  return selected;
}

function selectRawPublishers(selector, writers, assigned, authorityClassifications) {
  if (selector.inventoryRemainder === true) {
    return writers.filter(writer => (
      !assigned.has(rawPublisherIdentity(writer))
      && (!selector.authorityClassifications
        || selector.authorityClassifications.includes(
          authorityClassifications.get(writer.authorityId),
        ))
    ));
  }
  const absolute = resolve(repoRoot, selector.sourceFile);
  assert(existsSync(absolute), `raw publisher selector source is missing: ${selector.sourceFile}`);
  const selected = writers.filter(writer => (
    writer.sourceFile === selector.sourceFile
    && (!selector.enclosingFunctions
      || selector.enclosingFunctions.includes(writer.enclosingFunction))
    && (!selector.authorityIds || selector.authorityIds.includes(writer.authorityId))
  ));
  if (selector.enclosingFunctions) {
    for (const fn of selector.enclosingFunctions) {
      assert(
        selected.some(writer => writer.enclosingFunction === fn),
        `raw publisher selector matched no writer for missing symbol ${selector.sourceFile}#${fn}`,
      );
    }
  }
  if (selector.authorityIds) {
    for (const authorityId of selector.authorityIds) {
      assert(
        selected.some(writer => writer.authorityId === authorityId),
        `raw publisher selector matched no writer for authority ${authorityId}`,
      );
    }
  }
  assert(selected.length > 0, `raw publisher selector matched no writer: ${selector.sourceFile}`);
  return selected;
}

function validateAuthorityDisposition(entry, selected) {
  if (entry.id === 'projection' || entry.id === 'scheduler-retained-projection') {
    for (const site of selected) {
      assert(
        site.classification === 'projection',
        `${entry.id} coverage cannot include ${siteIdentity(site)} (classification ${site.classification})`,
      );
    }
    return;
  }
  if (entry.disposition !== 'retained') return;
  for (const site of selected) {
    const violations = [];
    if (site.classification !== 'path_specific_authority') {
      violations.push(`classification ${site.classification}`);
    }
    if (retainedForbiddenAccessLanes.has(site.accessLane)) {
      violations.push(`access lane ${site.accessLane}`);
    }
    assert(
      violations.length === 0,
      `retained coverage ${entry.id} cannot include ${siteIdentity(site)} (${violations.join(', ')})`,
    );
  }
}

function validateRawPublisherDisposition(entry, selected, authorityClassifications) {
  if (entry.disposition !== 'retained') return;
  for (const writer of selected) {
    const classification = authorityClassifications.get(writer.authorityId);
    assert(
      classification === 'path_specific_authority',
      `retained raw publisher ${rawPublisherIdentity(writer)} cannot include classification ${classification ?? 'unknown'}`,
    );
  }
}

function sourceFile(path) {
  if (activeSourceOverrides
      && Object.prototype.hasOwnProperty.call(activeSourceOverrides, path)) {
    const cachedOverride = activeOverrideParsedSources.get(path);
    if (cachedOverride) return cachedOverride;
    const source = activeSourceOverrides[path];
    assert(typeof source === 'string', `production source override must be text: ${path}`);
    const parsed = ts.createSourceFile(
      path,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    activeOverrideParsedSources.set(path, parsed);
    return parsed;
  }
  const cached = parsedSources.get(path);
  if (cached) return cached;
  const absolute = resolve(repoRoot, path);
  assert(existsSync(absolute), `production source is missing: ${path}`);
  const parsed = ts.createSourceFile(
    path,
    readFileSync(absolute, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  parsedSources.set(path, parsed);
  return parsed;
}

function declarationName(node) {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name) {
    return ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name) ? node.name.text : undefined;
  }
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isVariableDeclaration(node.parent)) {
    return ts.isIdentifier(node.parent.name) ? node.parent.name.text : undefined;
  }
  return undefined;
}

function findNamedFunction(parsed, name) {
  const matches = [];
  const visit = node => {
    if (declarationName(node) === name) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  assert(matches.length === 1, `missing or ambiguous production symbol ${parsed.fileName}#${name}`);
  return matches[0];
}

function findNamedClass(parsed, name) {
  const matches = [];
  const visit = node => {
    if (ts.isClassDeclaration(node) && node.name?.text === name) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  assert(matches.length === 1, `missing or ambiguous production class ${parsed.fileName}#${name}`);
  return matches[0];
}

function findIpcRouteHandler(parsed, method, path) {
  const matches = [];
  const visit = node => {
    if (ts.isCallExpression(node)
        && calledName(node) === 'ipcRoute'
        && node.arguments.length >= 3
        && ts.isStringLiteralLike(node.arguments[0])
        && node.arguments[0].text === method
        && ts.isStringLiteralLike(node.arguments[1])
        && node.arguments[1].text === path) {
      matches.push(node.arguments[2]);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  assert(
    matches.length === 1,
    `missing or ambiguous Dashboard route ${parsed.fileName}#${method} ${path}`,
  );
  const [handler] = matches;
  assert(
    ts.isArrowFunction(handler) || ts.isFunctionExpression(handler),
    `Dashboard route ${method} ${path} must keep an inline handler for caller-cut inspection`,
  );
  return handler;
}

function ipcRouteCallbacks(parsed) {
  const routes = [];
  const visit = node => {
    if (ts.isCallExpression(node)
        && calledName(node) === 'ipcRoute'
        && node.arguments.length >= 3) {
      const [methodArgument, pathArgument, handler] = node.arguments;
      const method = ts.isStringLiteralLike(methodArgument)
        ? methodArgument.text
        : methodArgument.getText(parsed);
      const path = ts.isStringLiteralLike(pathArgument)
        ? pathArgument.text
        : pathArgument.getText(parsed);
      assert(
        ts.isArrowFunction(handler) || ts.isFunctionExpression(handler),
        `Dashboard route ${method} ${path} must keep an inline callback for direct capability inspection`,
      );
      routes.push({ method, path, handler });
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return routes;
}

function containsStringLiteral(node, expected) {
  let found = false;
  const visit = current => {
    if (ts.isStringLiteralLike(current) && current.text === expected) found = true;
    if (!found) ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function containsIdentifier(node, expected) {
  let found = false;
  const visit = current => {
    if (ts.isIdentifier(current) && current.text === expected) found = true;
    if (!found) ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function propertyAccessExpressionsWithin(node, owner, property) {
  const accesses = [];
  const visit = current => {
    if (ts.isPropertyAccessExpression(current)
        && ts.isIdentifier(current.expression)
        && current.expression.text === owner
        && current.name.text === property) {
      accesses.push(current);
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return accesses;
}

function propertyAssignmentsWithin(node, owner, property, valueKind) {
  const assignments = [];
  const visit = current => {
    if (ts.isBinaryExpression(current)
        && current.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isPropertyAccessExpression(current.left)
        && ts.isIdentifier(current.left.expression)
        && current.left.expression.text === owner
        && current.left.name.text === property
        && (valueKind === undefined || current.right.kind === valueKind)) {
      assignments.push(current);
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return assignments;
}

function ifStatementsWithin(node) {
  const statements = [];
  const visit = current => {
    if (ts.isIfStatement(current)) statements.push(current);
    ts.forEachChild(current, visit);
  };
  visit(node);
  return statements;
}

function propertyLiteralIf(node, owner, property, literal) {
  return ifStatementsWithin(node).filter(statement => (
    propertyAccessExpressionsWithin(statement.expression, owner, property).length > 0
      && containsStringLiteral(statement.expression, literal)
  ));
}

function awaitExpressionsWithin(node) {
  const awaits = [];
  const visit = current => {
    if (ts.isAwaitExpression(current)) awaits.push(current);
    ts.forEachChild(current, visit);
  };
  visit(node);
  return awaits;
}

function assertSynchronousCallback(node, label) {
  assert(
    !!node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node)),
    `${label} must be an inline synchronous transition callback`,
  );
  assert(!node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword), `${label} must not be async`);
  assert(awaitExpressionsWithin(node).length === 0, `${label} must not contain await`);
}

function calledName(call) {
  const render = expression => {
    if (ts.isIdentifier(expression)) return expression.text;
    if (ts.isNonNullExpression(expression)
      || ts.isParenthesizedExpression(expression)
      || ts.isAsExpression(expression)
      || ts.isTypeAssertionExpression(expression)) {
      return render(expression.expression);
    }
    if (ts.isPropertyAccessExpression(expression)) {
      const owner = render(expression.expression);
      return owner ? `${owner}.${expression.name.text}` : expression.name.text;
    }
    return undefined;
  };
  return render(call.expression);
}

function matchesForbiddenCall(actual, forbidden) {
  return actual === forbidden || actual.endsWith(`.${forbidden}`);
}

function callsWithin(node) {
  const calls = [];
  const visit = current => {
    if (ts.isCallExpression(current)) {
      const name = calledName(current);
      if (name) calls.push(name);
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return calls;
}

function callExpressionsWithin(node, expected) {
  const calls = [];
  const visit = current => {
    if (ts.isCallExpression(current)) {
      const name = calledName(current);
      if (name && matchesForbiddenCall(name, expected)) calls.push(current);
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return calls;
}

function nodeContains(ancestor, descendant) {
  return ancestor.pos <= descendant.pos && descendant.end <= ancestor.end;
}

function ancestorWithin(node, boundary, predicate) {
  let current = node.parent;
  while (current && current !== boundary) {
    if (predicate(current)) return current;
    current = current.parent;
  }
  return undefined;
}

function guardedPortCallback(parsed, scope, guardName, portCall, label) {
  const guards = callExpressionsWithin(scope, guardName)
    .filter(call => nodeContains(call, portCall));
  assert(guards.length === 1, `${label} must pass through exactly one ${guardName} call`);
  const callback = resolvedTransitionCallback(parsed, guards[0].arguments[1], label);
  assertSynchronousCallback(callback, label);
  assert(nodeContains(callback, portCall), `${label} guard callback must invoke the port`);
  return guards[0];
}

function validateLaneExternalEffect(parsed, effectRunner, label) {
  const executeCalls = callExpressionsWithin(effectRunner, 'port.execute');
  assert(
    executeCalls.length === 1
      && !!ancestorWithin(executeCalls[0], effectRunner, ts.isAwaitExpression),
    `${label} must await exactly one port.execute effect`,
  );
  const laneCalls = callExpressionsWithin(effectRunner, 'commandLane.submit');
  assert(laneCalls.length > 0, `${label} must return through the Session lane`);
  for (const [index, laneCall] of laneCalls.entries()) {
    const callback = resolvedTransitionCallback(
      parsed,
      laneCall.arguments[1],
      `${label} Session lane callback ${index + 1}`,
    );
    assert(
      callExpressionsWithin(callback, 'port.execute').length === 0,
      `${label} Session lane callback must not invoke port.execute`,
    );
    assertSynchronousCallback(callback, `${label} Session lane callback ${index + 1}`);
  }
  assert(
    laneCalls.every(laneCall => !nodeContains(laneCall, executeCalls[0])),
    `${label} port.execute must remain outside every Session lane submission`,
  );
  const resumeLaneCalls = laneCalls.filter(laneCall => laneCall.pos > executeCalls[0].end);
  assert(
    resumeLaneCalls.length === 1
      && !!ancestorWithin(resumeLaneCalls[0], effectRunner, ts.isAwaitExpression),
    `${label} must await exactly one Session lane resume after port.execute`,
  );
}

function objectLiteralOwnPropertyNames(node) {
  assert(ts.isObjectLiteralExpression(node), 'production composition options must be an object literal');
  assert(
    node.properties.every(property => (
      !ts.isSpreadAssignment(property)
      && (!property.name || !ts.isComputedPropertyName(property.name))
    )),
    'production composition options must not hide capabilities behind spreads or computed keys',
  );
  return new Set(node.properties.flatMap(property => {
    if (!property.name) return [];
    if (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) {
      return [property.name.text];
    }
    return [];
  }));
}

function objectLiteralOwnProperty(node, expected) {
  objectLiteralOwnPropertyNames(node);
  return node.properties.find(property => {
    if (!property.name) return false;
    if (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) {
      return property.name.text === expected;
    }
    return false;
  });
}

function importedModules(parsed) {
  return parsed.statements
    .filter(ts.isImportDeclaration)
    .map(statement => statement.moduleSpecifier)
    .filter(ts.isStringLiteralLike)
    .map(specifier => specifier.text);
}

function verifyNoForbiddenCalls(node, forbiddenCalls, label) {
  for (const actual of callsWithin(node)) {
    const forbidden = forbiddenCalls.find(candidate => matchesForbiddenCall(actual, candidate));
    assert(!forbidden, `${label} contains forbidden direct-write capability ${actual}`);
  }
}

function validateMigratedProductionBinding(binding, authoritySites) {
  const parsed = sourceFile(binding.sourceFile);
  const fn = findNamedFunction(parsed, binding.enclosingFunction);
  const candidates = [];
  const visit = node => {
    if (ts.isCallExpression(node)) {
      const name = calledName(node);
      if (
        name && matchesForbiddenCall(name, binding.runtimeMethod)
        && containsStringLiteral(node, binding.commandKind)
      ) candidates.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(fn);
  assert(
    candidates.length === 1,
    `production binding ${binding.sourceFile}#${binding.enclosingFunction} must contain exactly one ${binding.runtimeMethod} for ${binding.commandKind}`,
  );

  let scope = candidates[0].parent;
  while (scope && scope !== fn && !ts.isIfStatement(scope)) scope = scope.parent;
  assert(scope && ts.isIfStatement(scope), `production binding for ${binding.commandKind} lost its nearestIf scope`);
  verifyNoForbiddenCalls(scope, binding.forbiddenCalls, `migrated production branch ${binding.commandKind}`);

  for (const path of binding.pureRuntimeSources) {
    const runtimeSource = sourceFile(path);
    const directSites = authoritySites.filter(site => site.sourceFile === path);
    assert(directSites.length === 0, `migrated runtime core ${path} gained direct Session authority sites`);
    verifyNoForbiddenCalls(runtimeSource, binding.forbiddenCalls, `migrated runtime core ${path}`);
    const imports = importedModules(runtimeSource);
    for (const forbidden of binding.forbiddenImports) {
      assert(!imports.includes(forbidden), `migrated runtime core ${path} imports forbidden direct-write capability ${forbidden}`);
    }
  }
}

function validateControlProductionBinding(binding, authoritySites, assigned) {
  const ipc = sourceFile(binding.ipcSource);
  const operationIdReader = findNamedFunction(ipc, binding.operationIdReader);
  assert(
    containsIdentifier(operationIdReader, 'operationId')
      && containsStringLiteral(operationIdReader, 'x-botmux-operation-id')
      && containsStringLiteral(operationIdReader, 'bad_operation_id')
      && callExpressionsWithin(operationIdReader, 'randomUUID').length === 0,
    'C2 Dashboard operation identity must be caller-supplied, exact across body/header, and never regenerated',
  );
  const ipcRoutes = ipcRouteCallbacks(ipc);
  for (const route of ipcRoutes) {
    verifyNoForbiddenCalls(
      route.handler,
      mandatoryIpcRouteForbiddenDirectWriteCalls,
      `Dashboard route ${route.method} ${route.path}`,
    );
  }
  const reviewedCallerRoutes = new Set(binding.routes
    .filter(route => route.identitySource === 'caller-supplied')
    .map(route => `${route.method} ${route.path}`));
  const discoveredCallerRoutes = new Set();
  for (const route of ipcRoutes) {
    const operationReads = callExpressionsWithin(route.handler, binding.operationIdReader);
    if (operationReads.length === 0) continue;
    const routeKey = `${route.method} ${route.path}`;
    assert(
      reviewedCallerRoutes.has(routeKey),
      `C2 Dashboard caller-operation route census found unreviewed route ${routeKey}`,
    );
    assert(
      operationReads.length === 1,
      `C2 Dashboard caller-operation route census requires exactly one identity read in ${routeKey}`,
    );
    discoveredCallerRoutes.add(routeKey);
  }
  for (const routeKey of reviewedCallerRoutes) {
    assert(
      discoveredCallerRoutes.has(routeKey),
      `C2 Dashboard caller-operation route census is missing reviewed route ${routeKey}`,
    );
  }
  for (const route of binding.routes) {
    const handler = findIpcRouteHandler(ipc, route.method, route.path);
    const callerOperationIds = callExpressionsWithin(handler, binding.operationIdReader);
    assert(
      route.identitySource === 'derived-trigger-id'
        ? callerOperationIds.length === 0
        : callerOperationIds.length === 1,
      route.identitySource === 'derived-trigger-id'
        ? `C2 Dashboard route ${route.method} ${route.path} must not invent a caller operation identity`
        : `C2 Dashboard route ${route.method} ${route.path} must read one stable operation identity`,
    );
    const sinkCalls = callExpressionsWithin(handler, route.sink);
    assert(
      sinkCalls.length === 1,
      `C2 Dashboard route ${route.method} ${route.path} must cross ${route.sink} exactly once`,
    );
    if (route.identitySource === 'caller-supplied') {
      const operationDeclaration = ancestorWithin(
        callerOperationIds[0],
        handler,
        ts.isVariableDeclaration,
      );
      assert(
        operationDeclaration
          && ts.isIdentifier(operationDeclaration.name)
          && operationDeclaration.initializer
          && nodeContains(operationDeclaration.initializer, callerOperationIds[0])
          && propertyAccessExpressionsWithin(
            sinkCalls[0],
            operationDeclaration.name.text,
            'value',
          ).length === 1,
        `C2 Dashboard route ${route.method} ${route.path} must flow operationId.value into its ${route.sink} sink`,
      );
    }
    if (route.delegatedFunction !== undefined) {
      const delegated = findNamedFunction(ipc, route.delegatedFunction);
      assert(
        callExpressionsWithin(delegated, route.delegatedSink).length === 1
          && containsStringLiteral(delegated, route.commandKind)
          && delegated.getText().includes('trigger-result-fault:')
          && containsIdentifier(delegated, 'memTriggerId'),
        `C2 Dashboard route ${route.method} ${route.path} must derive one stable convergence identity and submit ${route.commandKind}`,
      );
      verifyNoForbiddenCalls(
        delegated,
        binding.forbiddenCallerCalls,
        `C2 Dashboard delegated caller ${route.delegatedFunction}`,
      );
    } else if (route.commandKind !== undefined) {
      assert(
        containsStringLiteral(sinkCalls[0], route.commandKind),
        `C2 Dashboard route ${route.method} ${route.path} must submit ${route.commandKind}`,
      );
    }
    verifyNoForbiddenCalls(
      handler,
      binding.forbiddenCallerCalls,
      `C2 Dashboard caller ${route.method} ${route.path}`,
    );
  }

  const client = sourceFile(binding.commandClientSource);
  const operationKey = findNamedFunction(client, 'operationKey');
  assert(
    containsIdentifier(operationKey, 'sessionId')
      && containsIdentifier(operationKey, 'idempotencyKey')
      && /\\(?:0|u0000)/.test(operationKey.getText()),
    'C2 Dashboard external receipt key must bind Session identity and caller operation identity',
  );
  const executeExternal = findNamedFunction(client, 'executeExternal');
  assert(
    callExpressionsWithin(executeExternal, 'initialHost.projection.read').length === 1
      && callExpressionsWithin(executeExternal, 'host.projection.read').length === 2
      && callExpressionsWithin(executeExternal, 'host.runtime.submit').length === 2
      && containsIdentifier(executeExternal, 'controlRouteReservation')
      && containsStringLiteral(executeExternal, 'staleAddress'),
    'C2 Dashboard external-session client must boundedly re-project opaque addresses and submit only through Runtime',
  );
  const clientFactory = findNamedFunction(client, binding.commandClientFactory);
  assert(
    variableDeclarationsWithin(clientFactory, 'externalAttempts').length === 1
      && callExpressionsWithin(clientFactory, 'computeInputHash').length === 1
      && callExpressionsWithin(clientFactory, 'externalAttempts.set').length >= 2
      && callExpressionsWithin(clientFactory, 'externalAttempts.delete').length === 0
      && callExpressionsWithin(clientFactory, 'externalAttempts.clear').length === 0,
    'C2 Dashboard client must retain semantic operation receipts for the daemon epoch',
  );
  assert(
    callExpressionsWithin(clientFactory, 'withBotTurnAdmission').length === 1
      && callExpressionsWithin(clientFactory, 'host.runtime.submit').length === 1,
    'C2 Dashboard client must share fleet admission and delegate route commands to Runtime',
  );
  const clientSubmit = findNamedFunction(client, 'submit');
  assert(
    nodeContains(clientFactory, clientSubmit),
    'C2 Dashboard external receipt submit must remain inside the daemon-epoch client',
  );
  const externalExecuteCalls = callExpressionsWithin(clientSubmit, 'executeExternal');
  const runningReceiptCalls = callExpressionsWithin(clientSubmit, 'externalAttempts.set')
    .filter(call => containsStringLiteral(call, 'running'));
  const terminalAwaits = awaitExpressionsWithin(clientSubmit).filter(awaitExpression => (
    ts.isIdentifier(awaitExpression.expression)
      && awaitExpression.expression.text === 'terminal'
  ));
  const deferredCallback = externalExecuteCalls.length === 1
    ? ancestorWithin(
        externalExecuteCalls[0],
        clientSubmit,
        node => ts.isArrowFunction(node) || ts.isFunctionExpression(node),
      )
    : undefined;
  const deferredCall = deferredCallback && ts.isCallExpression(deferredCallback.parent)
    ? deferredCallback.parent
    : undefined;
  const thenExpression = deferredCall && ts.isPropertyAccessExpression(deferredCall.expression)
    ? deferredCall.expression
    : undefined;
  const promiseResolveCall = thenExpression && ts.isCallExpression(thenExpression.expression)
    ? thenExpression.expression
    : undefined;
  assert(
    externalExecuteCalls.length === 1
      && runningReceiptCalls.length === 1
      && terminalAwaits.length === 1
      && deferredCallback
      && deferredCall
      && deferredCall.arguments[0] === deferredCallback
      && thenExpression?.name.text === 'then'
      && promiseResolveCall
      && calledName(promiseResolveCall) === 'Promise.resolve'
      && promiseResolveCall.arguments.length === 0
      && deferredCall.end < runningReceiptCalls[0].pos
      && runningReceiptCalls[0].end < terminalAwaits[0].pos
      && containsIdentifier(runningReceiptCalls[0], 'terminal'),
    'C2 Dashboard running receipt must be published before executeExternal starts in a deferred microtask',
  );
  const terminalDeclaration = ancestorWithin(
    deferredCall,
    clientSubmit,
    ts.isVariableDeclaration,
  );
  const terminalStatement = ancestorWithin(deferredCall, clientSubmit, ts.isVariableStatement);
  const runningReceiptStatement = ancestorWithin(
    runningReceiptCalls[0],
    clientSubmit,
    ts.isExpressionStatement,
  );
  const receiptBlock = terminalStatement?.parent;
  const terminalStatementIndex = ts.isBlock(receiptBlock)
    ? receiptBlock.statements.indexOf(terminalStatement)
    : -1;
  assert(
    terminalDeclaration
      && ts.isIdentifier(terminalDeclaration.name)
      && terminalDeclaration.name.text === 'terminal'
      && terminalDeclaration.initializer === deferredCall
      && ts.isBlock(receiptBlock)
      && runningReceiptStatement?.parent === receiptBlock
      && receiptBlock.statements[terminalStatementIndex + 1] === runningReceiptStatement,
    'C2 Dashboard running receipt must be published immediately after queuing the execution microtask and before yielding to that microtask',
  );
  const directProjectionCalls = callExpressionsWithin(clientSubmit, 'projection.read');
  const directEffectCalls = callExpressionsWithin(clientSubmit, 'execute');
  assert(
    [...directProjectionCalls, ...directEffectCalls]
      .every(call => nodeContains(deferredCallback, call)),
    'C2 Dashboard running receipt must be published before projection or effect execution; every projection/execute call must remain in the deferred microtask',
  );

  const runtime = sourceFile(binding.runtimeSource);
  const runtimeFactory = findNamedFunction(runtime, binding.runtimeFactory);
  assert(
    containsStringLiteral(runtimeFactory, 'control.mutate')
      && containsStringLiteral(runtimeFactory, 'control.rename')
      && containsIdentifier(runtimeFactory, 'controlMutationPort')
      && containsIdentifier(runtimeFactory, 'controlRenameEffectPort'),
    'C2 Runtime must own typed control mutation and rename policy kernels',
  );
  const runtimeTransition = findNamedFunction(runtime, 'run');
  const mutationBeginGuards = callExpressionsWithin(
    runtimeTransition,
    'invokeSynchronousPort',
  ).filter(call => containsStringLiteral(call, 'ControlMutationPort.begin'));
  const mutationBeginCalls = mutationBeginGuards.flatMap(
    guard => callExpressionsWithin(guard, 'port.begin'),
  );
  assert(
    mutationBeginCalls.length === 1,
    'C2 control mutation must have exactly one staged begin transition',
  );
  guardedPortCallback(
    runtime,
    runtimeTransition,
    'invokeSynchronousPort',
    mutationBeginCalls[0],
    'C2 control mutation begin transition',
  );
  const renameBegin = findNamedFunction(runtime, 'beginControlRenameEffect');
  const renameBeginCalls = callExpressionsWithin(renameBegin, 'port.begin');
  assert(
    renameBeginCalls.length === 1,
    'C2 control rename must have exactly one staged begin transition',
  );
  guardedPortCallback(
    runtime,
    renameBegin,
    'invokeSynchronousPort',
    renameBeginCalls[0],
    'C2 control rename begin transition',
  );
  const mutationResume = findNamedFunction(runtime, binding.mutationResumeFunction);
  const mutationResumeCalls = callExpressionsWithin(mutationResume, 'port.resume');
  assert(
    mutationResumeCalls.length === 1,
    'C2 control mutation must have exactly one staged resume transition',
  );
  guardedPortCallback(
    runtime,
    mutationResume,
    'invokeSynchronousPort',
    mutationResumeCalls[0],
    'C2 control mutation resume transition',
  );
  const mutationEffects = findNamedFunction(runtime, binding.mutationEffectRunner);
  validateLaneExternalEffect(runtime, mutationEffects, 'C2 control mutation effect');
  const renameEffects = findNamedFunction(runtime, binding.renameEffectRunner);
  validateLaneExternalEffect(runtime, renameEffects, 'C2 native rename effect');
  const runtimeSubmit = findNamedFunction(runtime, binding.runtimeSubmitFunction);
  const mutationEffectDispatches = callExpressionsWithin(
    runtimeSubmit,
    binding.mutationEffectRunner,
  );
  const renameEffectDispatches = callExpressionsWithin(
    runtimeSubmit,
    binding.renameEffectRunner,
  );
  const submitLaneCalls = callExpressionsWithin(runtimeSubmit, 'commandLane.submit');
  assert(
    mutationEffectDispatches.length === 1
      && renameEffectDispatches.length === 1,
    'C2 Runtime submit must dispatch each staged control effect through one deep effect runner',
  );
  assert(
    submitLaneCalls.every(laneCall => (
      !nodeContains(laneCall, mutationEffectDispatches[0])
        && !nodeContains(laneCall, renameEffectDispatches[0])
    )),
    'C2 control mutation effect runner and rename effect runner must execute outside the Session lane',
  );
  const terminalEviction = findNamedFunction(runtime, 'retainTerminalIdempotency');
  assert(
    !containsIdentifier(terminalEviction, 'controlMutations')
      && !containsIdentifier(terminalEviction, 'controlCommands'),
    'C2 applied/unknown control receipts must not enter bounded transport eviction',
  );
  const settleControlMutation = findNamedFunction(runtime, 'settleControlMutationTransition');
  const quarantineControlMutation = findNamedFunction(runtime, 'quarantineControlMutationAttempt');
  assert(
    callExpressionsWithin(settleControlMutation, 'controlMutations.set').length === 3
      && containsStringLiteral(settleControlMutation, 'applied')
      && containsStringLiteral(settleControlMutation, 'unknown')
      && callExpressionsWithin(quarantineControlMutation, 'controlMutations.set').length === 1
      && containsStringLiteral(quarantineControlMutation, 'unknown'),
    'C2 control mutation must retain applied and response-loss unknown receipts for the Runtime epoch',
  );
  const settleControlRename = findNamedFunction(runtime, 'settleControlRename');
  const settleControlRenameUnknown = findNamedFunction(runtime, 'settleControlRenameUnknown');
  assert(
    callExpressionsWithin(settleControlRename, 'controlCommands.set').length === 1
      && containsStringLiteral(settleControlRename, 'applied')
      && callExpressionsWithin(settleControlRenameUnknown, 'controlCommands.set').length === 1
      && containsStringLiteral(settleControlRenameUnknown, 'unknown'),
    'C2 control rename must retain applied and response-loss unknown receipts for the Runtime epoch',
  );

  const control = sourceFile(binding.controlSource);
  const controlFactory = findNamedFunction(control, binding.controlFactory);
  const controlBegin = findNamedFunction(control, 'begin');
  const controlExecute = findNamedFunction(control, 'execute');
  const controlResume = findNamedFunction(control, 'resume');
  assert(
    nodeContains(controlFactory, controlBegin)
      && nodeContains(controlFactory, controlExecute)
      && nodeContains(controlFactory, controlResume)
      && awaitExpressionsWithin(controlBegin).length === 0
      && awaitExpressionsWithin(controlResume).length === 0
      && awaitExpressionsWithin(controlExecute).length > 0,
    'C2 Current control Adapter must keep synchronous begin/resume around one lane-external effect',
  );
  assert(
    callExpressionsWithin(controlFactory, 'options.activation.retire').length >= 1
      && callExpressionsWithin(controlFactory, 'options.activation.ensure').length >= 1
      && callExpressionsWithin(controlFactory, binding.activationCoordinatorFactory).length === 0,
    'C2 Current control Adapter must receive the owner/epoch A4 coordinator instead of minting one',
  );

  // The syntactic writes live in a shared provider and therefore remain in
  // `remaining-control-bypass`: the census cannot truthfully split one write
  // site by its callers. The production proof instead fixes the seam: Current
  // control reaches only the store-owned projection publisher, while the
  // legacy command path remains visibly attached to the durable direct writer.
  const cwd = sourceFile(binding.cwdSource);
  const cwdCurrentPublisher = findNamedFunction(cwd, binding.cwdCurrentPublisher);
  const cwdRemainingPublisher = findNamedFunction(cwd, binding.cwdRemainingPublisher);
  assert(
    callExpressionsWithin(controlFactory, binding.cwdCurrentPublisher).length === 1
      && callExpressionsWithin(controlFactory, binding.cwdRemainingPublisher).length === 0
      && callExpressionsWithin(cwdCurrentPublisher, 'assignWorkingDirectory').length === 1
      && callExpressionsWithin(cwdCurrentPublisher, 'publishWorkingDirectory').length === 1
      && callExpressionsWithin(cwdCurrentPublisher, 'sessionStore.updateSession').length === 0,
    'C2 Current cwd projection must cross the non-durable shared publisher exactly once',
  );
  assert(
    callExpressionsWithin(cwdRemainingPublisher, 'assignWorkingDirectory').length === 1
      && callExpressionsWithin(cwdRemainingPublisher, 'sessionStore.updateSession').length === 1
      && callExpressionsWithin(cwdRemainingPublisher, 'publishWorkingDirectory').length === 1,
    'C2 cwd census boundary must keep the legacy durable writer explicit as remaining-control-bypass',
  );

  const routeRegistry = sourceFile(binding.routeRegistrySource);
  const routeRegistryFactory = findNamedFunction(routeRegistry, binding.routeRegistryFactory);
  const dashboardSpawn = findNamedFunction(routeRegistry, 'submitDashboardSpawnRoute');
  assert(
    nodeContains(routeRegistryFactory, dashboardSpawn)
      && callExpressionsWithin(dashboardSpawn, 'opening.inspect').length === 1
      && callExpressionsWithin(dashboardSpawn, 'opening.begin').length === 1
      && callExpressionsWithin(dashboardSpawn, 'opening.execute').length === 1
      && callExpressionsWithin(dashboardSpawn, 'opening.resume').length === 1
      && !!ancestorWithin(
        callExpressionsWithin(dashboardSpawn, 'opening.execute')[0],
        dashboardSpawn,
        ts.isAwaitExpression,
      )
      && containsIdentifier(routeRegistryFactory, 'dashboardSpawnRecords')
      && containsIdentifier(routeRegistryFactory, 'relocationRecords')
      && containsIdentifier(routeRegistryFactory, 'routeUnknowns'),
    'C2 route Adapter must stage Dashboard opening and retain route/relocation uncertainty receipts',
  );
  const opening = sourceFile(binding.openingSource);
  const openingFactory = findNamedFunction(opening, binding.openingFactory);
  for (const method of ['begin', 'execute', 'resume']) {
    assert(
      nodeContains(openingFactory, findNamedFunction(opening, method)),
      `C2 Dashboard opening Adapter must own ${method}`,
    );
  }
  const openingBarrier = findNamedFunction(
    sourceFile(binding.dashboardOpeningBarrierSource),
    binding.dashboardOpeningBarrierFunction,
  );
  const openingBarrierText = openingBarrier.getText();
  assert(
    callExpressionsWithin(openingBarrier, 'withActiveSessionKeyLock').length === 1
      && openingBarrierText.includes('dashboardSpawnOpeningPending: true')
      && openingBarrierText.includes('ds.dashboardSpawnOpeningPending = false')
      && callExpressionsWithin(openingBarrier, 'forkOrShowRepoCard').length === 1,
    'C2 Dashboard opening must hold one visible route barrier through worker/repo installation',
  );

  const maintenance = sourceFile(binding.maintenanceSource);
  const maintenanceFactory = findNamedFunction(maintenance, binding.maintenanceFactory);
  assert(
    containsIdentifier(maintenanceFactory, 'batches')
      && containsIdentifier(maintenanceFactory, 'agentChangeOperations')
      && callExpressionsWithin(maintenanceFactory, 'batches.delete').length === 0
      && callExpressionsWithin(maintenanceFactory, 'batches.clear').length === 0,
    'C2 host maintenance must retain one fixed candidate batch per stable operation identity',
  );
  const chatRename = sourceFile(binding.chatRenameSource);
  const chatRenameFactory = findNamedFunction(chatRename, binding.chatRenameFactory);
  assert(
    containsIdentifier(chatRenameFactory, 'attempts')
      && callExpressionsWithin(chatRenameFactory, 'computeInputHash').length === 1
      && callExpressionsWithin(chatRenameFactory, 'attempts.delete').length === 0
      && callExpressionsWithin(chatRenameFactory, 'attempts.clear').length === 0,
    'C2 chat rename must retain success/unknown receipts for the daemon epoch',
  );

  // These are transport receipts rather than Session authority selectors.
  // They still form part of the C2 caller cut: a retry must reach the same
  // daemon operation instead of expanding a new aggregate/fleet mutation.
  const aggregator = sourceFile(binding.aggregatorSource);
  const createOperationHost = findNamedFunction(
    aggregator,
    binding.createOperationHostFactory,
  );
  const idleOperationHost = findNamedFunction(
    aggregator,
    binding.idleOperationHostFactory,
  );
  for (const [label, host] of [
    ['create-session', createOperationHost],
    ['idle-cleanup', idleOperationHost],
  ]) {
    assert(
      containsIdentifier(host, 'receipts')
        && containsStringLiteral(host, 'processLocal')
        && callExpressionsWithin(host, 'receipts.set').length >= 2
        && callExpressionsWithin(host, 'receipts.delete').length === 0
        && callExpressionsWithin(host, 'receipts.clear').length === 0,
      `C2 Dashboard ${label} parent operation must retain one process-epoch receipt`,
    );
  }
  assert(
    containsIdentifier(idleOperationHost, 'priorBatch')
      && callExpressionsWithin(idleOperationHost, 'driveDashboardIdleCleanupAttempt').length === 1,
    'C2 idle cleanup retries must continue one frozen candidate batch',
  );
  const aggregatorOperationId = findNamedFunction(
    aggregator,
    binding.aggregatorOperationIdReader,
  );
  assert(
    containsStringLiteral(aggregatorOperationId, 'x-botmux-operation-id')
      && containsIdentifier(aggregatorOperationId, 'bodyValue')
      && callExpressionsWithin(aggregatorOperationId, 'randomUUID').length === 0,
    'C2 Dashboard aggregator must require one matching body/header operation identity',
  );
  const idleChildExecutor = findNamedFunction(aggregator, binding.idleChildExecutor);
  assert(
    containsStringLiteral(idleChildExecutor, 'x-botmux-operation-id')
      && containsIdentifier(idleChildExecutor, 'operationId'),
    'C2 idle cleanup must forward the fixed child operation identity in header and body',
  );
  assert(
    callExpressionsWithin(aggregator, 'dashboardSessionCreateOperations.run').length === 1
      && callExpressionsWithin(aggregator, 'dashboardIdleCleanupOperations.run').length === 1,
    'C2 Dashboard aggregator mutation routes must cross their parent receipt hosts exactly once',
  );

  const webOperations = sourceFile(binding.webOperationSource);
  const webCoordinator = findNamedClass(webOperations, binding.webOperationCoordinator);
  const webBegin = findNamedFunction(webOperations, 'begin');
  const webFinish = findNamedFunction(webOperations, 'finish');
  const webReconcile = findNamedFunction(webOperations, 'reconcile');
  assert(
    nodeContains(webCoordinator, webBegin)
      && nodeContains(webCoordinator, webFinish)
      && nodeContains(webCoordinator, webReconcile)
      && containsStringLiteral(webCoordinator, 'unknown')
      && containsIdentifier(webFinish, 'disposition')
      && containsStringLiteral(webCoordinator, 'outcome_unknown'),
    'C2 browser operation coordinator must reuse retryable identities and quarantine unknown outcomes',
  );

  const sessionsCard = sourceFile(binding.sessionsCardSource);
  const sessionsCardBuilder = findNamedFunction(sessionsCard, binding.sessionsCardBuilder);
  const sessionsCardHandler = findNamedFunction(sessionsCard, binding.sessionsCardHandler);
  assert(
    callExpressionsWithin(sessionsCardBuilder, 'randomUUID').length === 1
      && containsIdentifier(sessionsCardBuilder, 'writeOperationId')
      && containsIdentifier(sessionsCardBuilder, 'operation_id'),
    'C2 Sessions card must embed one stable lifecycle operation identity per rendered card',
  );
  assert(
    callExpressionsWithin(sessionsCardHandler, 'validCardOperationId').length === 2
      && callExpressionsWithin(sessionsCardHandler, 'client.request').length >= 2
      && containsIdentifier(sessionsCardHandler, 'operationId'),
    'C2 Sessions card callbacks must validate and forward the rendered operation identity',
  );

  const routeAdmission = sourceFile(binding.routeAdmissionSource);
  findNamedFunction(routeAdmission, binding.routeAdmissionFactory);
  for (const consumer of binding.sharedRouteAdmissionConsumers) {
    const parsed = sourceFile(consumer.sourceFile);
    const fn = findNamedFunction(parsed, consumer.enclosingFunction);
    assert(
      importedModules(parsed).includes('./current-route-admission.js')
        && callExpressionsWithin(fn, binding.routeAdmissionFactory).length
          === consumer.reservationCount,
      `C2 ${consumer.sourceFile}#${consumer.enclosingFunction} must share the one Current route admission module`,
    );
  }

  const currentRuntime = sourceFile(binding.currentRuntimeSource);
  const currentRuntimeFactory = findNamedFunction(
    currentRuntime,
    binding.currentRuntimeFactory,
  );
  assert(
    callExpressionsWithin(currentRuntimeFactory, binding.runtimeFactory).length === 1
      && containsIdentifier(currentRuntimeFactory, 'controlMutation')
      && containsIdentifier(currentRuntimeFactory, 'controlRenameEffect'),
    'C2 Current Host must inject both control ports into the one owner/epoch Runtime',
  );
  const daemon = sourceFile(binding.daemonSource);
  const daemonActivation = findNamedFunction(daemon, binding.daemonActivationFactory);
  const daemonHost = findNamedFunction(daemon, binding.daemonHostFactory);
  assert(
    callExpressionsWithin(daemonActivation, binding.activationCoordinatorFactory).length === 1
      && containsIdentifier(daemonActivation, 'requireBotId')
      && containsIdentifier(daemonActivation, 'getDaemonBootId'),
    'C2 daemon must resolve the A4 coordinator from immutable BotId + boot epoch',
  );
  assert(
    callExpressionsWithin(daemonHost, binding.daemonActivationFactory).length === 1
      && callExpressionsWithin(daemonHost, binding.currentRuntimeFactory).length === 1
      && containsIdentifier(daemonHost, 'activation')
      && containsIdentifier(daemonHost, 'controlMutation'),
    'C2 daemon Host must inject the same A4 coordinator into control and Runtime composition',
  );
  assert(
    callExpressionsWithin(daemon, binding.commandClientFactory).length === 1
      && callExpressionsWithin(daemon, 'setDashboardSessionRuntimeSubmitter').length === 1
      && callExpressionsWithin(daemon, binding.maintenanceFactory).length === 1
      && callExpressionsWithin(daemon, binding.chatRenameFactory).length === 1,
    'C2 daemon must install one epoch-stable Dashboard client and its host-level control adapters',
  );

  for (const site of authoritySites.filter(site => (
    site.accessLane === 'session-runtime-current-adapter'
      && [
        binding.controlSource,
        binding.openingSource,
        binding.routeRegistrySource,
        binding.dashboardOpeningBarrierSource,
      ].includes(site.sourceFile)
  ))) {
    assert(
      assigned.get(siteIdentity(site)) === 'dashboard-control'
        || assigned.get(siteIdentity(site)) === 'ordinary-im',
      `C2 Current authority site escaped an exact migrated caller cut: ${siteIdentity(site)}`,
    );
  }
}

function validateSchedulerProductionBinding(binding, authoritySites) {
  const producer = sourceFile(binding.producerSource);
  const setter = findNamedFunction(producer, binding.submitSetter);
  const deadline = findNamedFunction(producer, binding.deadlineProducer);
  const manual = findNamedFunction(producer, binding.manualProducer);
  assert(
    containsIdentifier(setter, 'submitCallback'),
    'C4 scheduler callback setter must bind the envelope submission seam',
  );
  assert(
    callExpressionsWithin(deadline, 'createDeadlineScheduledFireIdentity').length === 1
      && callExpressionsWithin(deadline, 'createManualScheduledFireIdentity').length === 1
      && callExpressionsWithin(deadline, 'createScheduledFireEnvelope').length === 2,
    'C4 tick producer must mint one deadline and one offline-manual structured envelope path',
  );
  assert(
    callExpressionsWithin(manual, 'createManualScheduledFireIdentity').length === 1
      && callExpressionsWithin(manual, 'createScheduledFireEnvelope').length === 1,
    'C4 manual producer must mint exactly one structured manual identity and envelope',
  );
  verifyNoForbiddenCalls(producer, binding.forbiddenProducerCalls, 'C4 scheduler producer');
  assert(
    !importedModules(producer).includes('./session-manager.js')
      && !importedModules(producer).includes('./worker-pool.js'),
    'C4 scheduler producer must not import legacy Session execution capabilities',
  );

  const identity = sourceFile(binding.identitySource);
  findNamedFunction(identity, 'scheduledRunId');
  findNamedFunction(identity, 'createDeadlineScheduledFireIdentity');
  findNamedFunction(identity, 'createManualScheduledFireIdentity');
  findNamedFunction(identity, 'createScheduledFireEnvelope');

  const daemon = sourceFile(binding.daemonSource);
  const daemonFunction = findNamedFunction(daemon, binding.daemonFunction);
  assert(
    callExpressionsWithin(daemonFunction, `scheduler.${binding.submitSetter}`).length === 1
      && containsStringLiteral(daemonFunction, binding.commandKind),
    'C4 daemon must wire exactly one scheduled.fire Runtime submission callback',
  );
  assert(
    !callsWithin(daemonFunction).some(name => matchesForbiddenCall(name, 'executeScheduledTask')),
    'C4 daemon must not call the legacy direct scheduled executor',
  );
  const daemonHost = findNamedFunction(daemon, binding.daemonHostFactory);
  assert(
    callExpressionsWithin(daemonHost, 'adapter.wrapRuntime').length === 1,
    'C4 daemon Host must wrap the owner Runtime with the scheduled route adapter',
  );

  const runtime = sourceFile(binding.runtimeSource);
  const runtimeFactory = findNamedFunction(runtime, binding.runtimeFactory);
  assert(
    containsStringLiteral(runtimeFactory, binding.commandKind)
      && containsIdentifier(runtimeFactory, 'scheduledFirePort'),
    'C4 Runtime must own the scheduled.fire command and private execution port',
  );
  const effectRunner = findNamedFunction(runtime, 'runScheduledEffects');
  const effectCalls = callExpressionsWithin(effectRunner, 'port.execute');
  assert(
    effectCalls.length === 1
      && !!ancestorWithin(effectCalls[0], effectRunner, ts.isAwaitExpression)
      && callExpressionsWithin(effectRunner, 'commandLane.submit').length === 2,
    'C4 scheduled external effect must execute outside the lane and resume through one lane submit',
  );
  assert(
    containsStringLiteral(runtimeFactory, binding.durability),
    'C4 Runtime outcome must state its process-local durability boundary',
  );

  const currentRuntime = sourceFile(binding.currentRuntimeSource);
  const currentRuntimeFactory = findNamedFunction(
    currentRuntime,
    binding.currentRuntimeFactory,
  );
  assert(
    containsIdentifier(currentRuntimeFactory, 'scheduledFire'),
    'C4 Current Host must bind the scheduled execution port by owner epoch',
  );

  const adapter = sourceFile(binding.adapterSource);
  const adapterFactory = findNamedFunction(adapter, binding.adapterFactory);
  assert(
    callExpressionsWithin(adapterFactory, 'reserveCurrentRouteAdmission').length === 2
      && callExpressionsWithin(adapterFactory, 'downstream.runtime.submit').length >= 1,
    'C4 Current adapter must share route admission and submit through the downstream Runtime',
  );

  const legacy = sourceFile(binding.legacyBridgeSource);
  const legacyBridge = findNamedFunction(legacy, binding.legacyBridgeFunction);
  assert(
    callExpressionsWithin(legacyBridge, 'executeScheduledTaskThroughRuntime').length === 1,
    'C4 legacy bridge must be a single Runtime delegation',
  );
  verifyNoForbiddenCalls(
    legacyBridge,
    binding.forbiddenProducerCalls,
    'C4 legacy bridge',
  );

  assert(
    authoritySites.filter(site => (
      site.sourceFile === binding.adapterSource
        || site.sourceFile === 'src/core/silent-schedule-turns.ts'
    )).length === 20,
    'C4 migrated authority partition must remain exactly 20 records',
  );
}

function validateExecutorProductionBinding(binding, authoritySites, assigned) {
  const worker = sourceFile(binding.workerSource);
  const handler = findNamedFunction(worker, binding.handlerFunction);
  const reservation = findNamedFunction(worker, binding.reservationFunction);
  assert(
    callExpressionsWithin(reservation, 'sessionExecutorRuntime.commitGeneration').length === 1,
    `executor reservation ${binding.workerSource}#${binding.reservationFunction} must delegate exactly once to commitGeneration`,
  );
  assert(
    authoritySites.every(site => !(
      site.sourceFile === binding.workerSource
      && site.enclosingFunction === binding.reservationFunction
    )),
    `executor reservation ${binding.workerSource}#${binding.reservationFunction} regained direct Session authority`,
  );
  assert(
    callExpressionsWithin(handler, 'sessionExecutorRuntime.activate').length === 1,
    `executor handler ${binding.workerSource}#${binding.handlerFunction} must activate exactly one opaque lease`,
  );
  assert(
    callExpressionsWithin(handler, 'sessionExecutorRuntime.isCurrent').length > 0,
    `executor handler ${binding.workerSource}#${binding.handlerFunction} must gate long-lived effects through isCurrent`,
  );
  assert(
    callExpressionsWithin(handler, 'sessionExecutorRuntime.resume').length > 0,
    `executor handler ${binding.workerSource}#${binding.handlerFunction} must revalidate async continuations`,
  );
  const reportCalls = callExpressionsWithin(handler, 'sessionExecutorRuntime.report');
  for (const kind of binding.observationKinds) {
    assert(
      reportCalls.some(call => containsStringLiteral(call, kind)),
      `executor handler ${binding.workerSource}#${binding.handlerFunction} does not report ${kind}`,
    );
  }
  assert(
    callExpressionsWithin(handler, 'createCurrentDispatchInputCommitEvidencePort').length === 1,
    `executor handler ${binding.workerSource}#${binding.handlerFunction} must bind one named input-commit evidence Adapter`,
  );
  assert(
    callExpressionsWithin(handler, 'recordDispatchInputCommit').length === 0,
    `executor handler ${binding.workerSource}#${binding.handlerFunction} bypasses the named input-commit evidence Adapter`,
  );

  const runtime = sourceFile(binding.runtimeSource);
  const runtimeSites = authoritySites.filter(site => site.sourceFile === binding.runtimeSource);
  assert(runtimeSites.length === 0, `executor Runtime core ${binding.runtimeSource} gained direct Session authority sites`);
  const forbiddenRuntimeImports = ['../services/session-store.js', './worker-pool.js'];
  const runtimeImports = importedModules(runtime);
  for (const forbidden of forbiddenRuntimeImports) {
    assert(
      !runtimeImports.includes(forbidden),
      `executor Runtime core ${binding.runtimeSource} imports forbidden Current capability ${forbidden}`,
    );
  }

  for (const adapterSource of [binding.currentAdapterSource, binding.evidenceAdapterSource]) {
    sourceFile(adapterSource);
    const adapterSites = authoritySites.filter(site => site.sourceFile === adapterSource);
    assert(adapterSites.length > 0, `executor Current Adapter ${adapterSource} has no reviewed authority evidence`);
    for (const site of adapterSites) {
      assert(
        site.accessLane === executorRuntimeAccessLane,
        `executor Current Adapter ${siteIdentity(site)} escaped the named access lane`,
      );
      assert(
        assigned.get(siteIdentity(site)) === 'executor-generation',
        `executor Current Adapter ${siteIdentity(site)} is not covered by the migrated A2 partition`,
      );
    }
  }
  for (const site of authoritySites.filter(site => site.accessLane === executorRuntimeAccessLane)) {
    assert(
      assigned.get(siteIdentity(site)) === 'executor-generation',
      `executor access-lane site ${siteIdentity(site)} is not covered by the migrated A2 partition`,
    );
  }
}

function resolvedTransitionCallback(parsed, argument, label) {
  if (argument && (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument))) {
    return argument;
  }
  if (argument && ts.isIdentifier(argument)) return findNamedFunction(parsed, argument.text);
  throw new Error(`${label} must name an inline or local synchronous transition callback`);
}

function variableDeclarationsWithin(node, expected) {
  const declarations = [];
  const visit = current => {
    if (ts.isVariableDeclaration(current)
      && ts.isIdentifier(current.name)
      && current.name.text === expected) {
      declarations.push(current);
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return declarations;
}

function mutationsWithinRange(node, start, end) {
  const mutations = [];
  const mutatingMethods = new Set([
    'add',
    'clear',
    'createSession',
    'delete',
    'pop',
    'push',
    'reverse',
    'set',
    'shift',
    'sort',
    'splice',
    'unshift',
    'updateSession',
  ]);
  const visit = current => {
    if (current.end < start || current.pos > end) return;
    if (ts.isBinaryExpression(current)
      && current.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && current.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      mutations.push(current);
    } else if (ts.isDeleteExpression(current)
      || ts.isPostfixUnaryExpression(current)
      || (ts.isPrefixUnaryExpression(current)
        && (current.operator === ts.SyntaxKind.PlusPlusToken
          || current.operator === ts.SyntaxKind.MinusMinusToken))) {
      mutations.push(current);
    } else if (ts.isCallExpression(current)) {
      const name = calledName(current)?.split('.').at(-1);
      if (name && mutatingMethods.has(name)) mutations.push(current);
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return mutations;
}

function ordinaryCallerSlice(parsed, caller, submitCall, forbiddenCalls, label) {
  const block = ancestorWithin(submitCall, caller, ts.isBlock);
  assert(block, `${label} submit must remain in one lexical caller block`);
  const compileCalls = callExpressionsWithin(block, 'compileLarkOrdinaryImTurn')
    .filter(call => call.pos < submitCall.pos)
    .sort((left, right) => right.pos - left.pos);
  assert(compileCalls.length > 0, `${label} must compile one typed ordinary transport turn`);
  const compileStatement = block.statements.find(statement => nodeContains(statement, compileCalls[0]));
  const submitStatement = block.statements.find(statement => nodeContains(statement, submitCall));
  const terminalReturn = block.statements.find(statement => (
    ts.isReturnStatement(statement) && statement.pos > submitCall.pos
  ));
  assert(
    compileStatement && submitStatement && terminalReturn,
    `${label} must end its compiled ordinary path after the one submit`,
  );
  const start = compileStatement.pos;
  const end = terminalReturn.end;
  const submitCalls = callExpressionsWithin(block, 'host.runtime.submit')
    .filter(call => call.pos >= start && call.end <= end && containsStringLiteral(call, 'ordinary.ingress'));
  assert(submitCalls.length === 1, `${label} compiled ordinary path must contain one submit`);
  for (const forbidden of forbiddenCalls) {
    const calls = callExpressionsWithin(block, forbidden)
      .filter(call => call.pos >= start && call.end <= end);
    assert(calls.length === 0, `${label} ordinary path regressed to direct ${forbidden}`);
  }
  assert(
    mutationsWithinRange(block, start, end).length === 0,
    `${label} ordinary path must not regain direct Session/registry mutation after compilation`,
  );
}

function assertDirectFactoryOption(call, propertyName, factoryName, label) {
  const option = objectLiteralOwnProperty(call.arguments[0], propertyName);
  assert(
    option
      && ts.isPropertyAssignment(option)
      && ts.isCallExpression(option.initializer)
      && calledName(option.initializer) === factoryName,
    `${label} must inject ${propertyName} from ${factoryName}`,
  );
}

function validateOrdinaryProductionBinding(binding, authoritySites, assigned) {
  const daemon = sourceFile(binding.daemonSource);
  const daemonHost = findNamedFunction(daemon, binding.daemonHostFactory);
  const hostComposition = callExpressionsWithin(daemonHost, binding.currentRuntimeFactory);
  assert(hostComposition.length === 1, 'C1 daemon must compose exactly one stable Current Host shape');
  assertDirectFactoryOption(
    hostComposition[0],
    'ordinaryIngress',
    'currentOrdinaryIngressPort',
    'C1 daemon Current Host',
  );
  assertDirectFactoryOption(
    hostComposition[0],
    'ordinaryRouteOpeningCreator',
    'currentOrdinaryOpeningCreator',
    'C1 daemon Current Host',
  );
  assertDirectFactoryOption(
    hostComposition[0],
    'pendingRepoCompletion',
    binding.pendingRepoPortFactory,
    'C1 daemon Current Host',
  );

  const daemonIngressFactory = findNamedFunction(daemon, 'currentOrdinaryIngressPort');
  assert(
    callExpressionsWithin(daemonIngressFactory, binding.ingressDaemonFactory).length === 1
      && containsIdentifier(daemonIngressFactory, 'currentOrdinaryIngressPorts'),
    'C1 daemon ordinary ingress port must remain owner-cached and fully composed',
  );
  const daemonOpeningFactory = findNamedFunction(daemon, 'currentOrdinaryOpeningCreator');
  assert(
    callExpressionsWithin(daemonOpeningFactory, binding.routeOpeningFactory).length === 1
      && containsIdentifier(daemonOpeningFactory, 'currentOrdinaryOpeningCreators')
      && containsIdentifier(daemonOpeningFactory, 'ownerBootId'),
    'C1 daemon route-opening creator must remain owner/boot stable',
  );

  const currentRuntime = sourceFile(binding.currentRuntimeSource);
  const currentRuntimeFactory = findNamedFunction(currentRuntime, binding.currentRuntimeFactory);
  assert(
    callExpressionsWithin(currentRuntimeFactory, 'createSessionRuntimeHost').length === 1
      && callExpressionsWithin(currentRuntimeFactory, binding.routeRegistryFactory).length === 1
      && containsIdentifier(currentRuntimeFactory, 'hostsByRegistry')
      && containsIdentifier(currentRuntimeFactory, 'portBindings')
      && containsIdentifier(currentRuntimeFactory, 'ordinaryCompatible')
      && containsIdentifier(currentRuntimeFactory, 'routeCreatorCompatible')
      && containsIdentifier(currentRuntimeFactory, 'pendingRepoCompatible'),
    'C1 Current Host must keep one owner/epoch cache while adding all production ports',
  );

  const ingressDaemon = sourceFile(binding.ingressDaemonSource);
  const ingressDaemonFactory = findNamedFunction(ingressDaemon, binding.ingressDaemonFactory);
  assert(
    callExpressionsWithin(ingressDaemonFactory, binding.ingressLarkFactory).length === 1,
    'C1 daemon ingress Adapter must compose the Lark production port exactly once',
  );
  const ingressLark = sourceFile(binding.ingressLarkSource);
  const ingressLarkFactory = findNamedFunction(ingressLark, binding.ingressLarkFactory);
  assert(
    callExpressionsWithin(ingressLarkFactory, binding.ingressCoreFactory).length === 1,
    'C1 Lark materializer must compose the core production port exactly once',
  );
  const ingressCore = sourceFile(binding.ingressCoreSource);
  const ingressCoreFactory = findNamedFunction(ingressCore, binding.ingressCoreFactory);
  assert(
    callExpressionsWithin(ingressCoreFactory, mandatorySessionLaneBinding.ordinaryPolicyFactory).length === 1,
    'C1 core production port must terminate at the staged ordinary policy exactly once',
  );
  const ordinaryQueuedRecovery = findNamedFunction(
    ingressCore,
    binding.ordinaryQueuedActivationRecoveryFunction,
  );
  assert(
    callExpressionsWithin(
      ordinaryQueuedRecovery,
      binding.queuedActivationRecoveryFunction,
    ).length === 1,
    'C1 ordinary queued-activation recovery must use the one typed A4 recovery helper',
  );
  findNamedFunction(sourceFile(binding.routeOpeningSource), binding.routeOpeningFactory);
  findNamedFunction(sourceFile(binding.routeRegistrySource), binding.routeRegistryFactory);

  const pendingSubmit = sourceFile(binding.pendingRepoSubmitSource);
  const pendingPortFactory = findNamedFunction(pendingSubmit, binding.pendingRepoPortFactory);
  assert(
    callExpressionsWithin(pendingPortFactory, binding.pendingRepoProductionFactory).length === 1
      && containsIdentifier(pendingPortFactory, 'portsByRegistry')
      && containsIdentifier(pendingPortFactory, 'ownerBootId'),
    'C1 pending-repo port must remain registry/owner/boot stable',
  );
  const pendingSubmitFunction = findNamedFunction(
    pendingSubmit,
    binding.pendingRepoSubmitFunction,
  );
  assert(
    callExpressionsWithin(pendingSubmitFunction, binding.currentRuntimeFactory).length === 1
      && callExpressionsWithin(pendingSubmitFunction, binding.pendingRepoPortFactory).length === 1
      && callExpressionsWithin(pendingSubmitFunction, 'host.runtime.submit').length === 1
      && containsStringLiteral(pendingSubmitFunction, 'pendingRepo.complete')
      && containsStringLiteral(pendingSubmitFunction, 'session'),
    'C1 pending-repo helper must project and submit one semantic first-start command through the stable Host',
  );
  const pendingProduction = sourceFile(binding.pendingRepoProductionSource);
  findNamedFunction(pendingProduction, binding.pendingRepoProductionFactory);
  const pendingDispatch = findNamedFunction(
    pendingProduction,
    binding.pendingRepoDispatchFunction,
  );
  assert(
    callExpressionsWithin(
      pendingDispatch,
      binding.queuedActivationRecoveryFunction,
    ).length === 1,
    'C1 pending-repo dispatch must route an empty first-start tail through the one typed A4 recovery helper',
  );

  for (const callerBinding of binding.ordinaryCallers) {
    const parsed = sourceFile(callerBinding.sourceFile);
    const caller = findNamedFunction(parsed, callerBinding.enclosingFunction);
    const submits = callExpressionsWithin(caller, 'host.runtime.submit')
      .filter(call => containsStringLiteral(call, 'ordinary.ingress'));
    const sessionSubmits = submits.filter(call => containsStringLiteral(call, 'session'));
    const routeSubmits = submits.filter(call => containsStringLiteral(call, 'route'));
    assert(
      submits.length === callerBinding.sessionSubmitCount + callerBinding.routeSubmitCount
        && sessionSubmits.length === callerBinding.sessionSubmitCount
        && routeSubmits.length === callerBinding.routeSubmitCount
        && callExpressionsWithin(caller, binding.daemonHostFactory).length === submits.length,
      `C1 ordinary caller ${callerBinding.enclosingFunction} must use one stable Host submit per existing/route path`,
    );
    for (const [index, submit] of submits.entries()) {
      ordinaryCallerSlice(
        parsed,
        caller,
        submit,
        binding.forbiddenOrdinaryCallerCalls,
        `C1 ${callerBinding.enclosingFunction} submit ${index + 1}`,
      );
    }
  }

  for (const callerBinding of binding.pendingRepoCallerCuts) {
    const parsed = sourceFile(callerBinding.sourceFile);
    const caller = findNamedFunction(parsed, callerBinding.enclosingFunction);
    let submitCalls;
    if (callerBinding.submissionMode === 'production-direct') {
      submitCalls = callExpressionsWithin(caller, binding.pendingRepoSubmitFunction);
    } else {
      const adapters = variableDeclarationsWithin(caller, 'submit').filter(declaration => (
        declaration.initializer
          && containsIdentifier(declaration.initializer, binding.pendingRepoSubmitFunction)
      ));
      submitCalls = callExpressionsWithin(caller, 'submit')
        .filter(call => ts.isIdentifier(call.expression) && call.expression.text === 'submit');
      assert(
        adapters.length === 1,
        `C1 pending-repo caller ${callerBinding.enclosingFunction} must retain one injected-or-production Current submit seam`,
      );
    }
    assert(
      submitCalls.length === 1,
      `C1 pending-repo caller ${callerBinding.enclosingFunction} must issue exactly one production submit`,
    );
    const guarded = ancestorWithin(submitCalls[0], caller, ts.isIfStatement);
    if (callerBinding.guardedByPendingRepo) {
      assert(
        guarded
          && containsIdentifier(guarded.expression, 'pendingRepo')
          && nodeContains(guarded.thenStatement, submitCalls[0])
          && callExpressionsWithin(guarded.thenStatement, 'forkWorker').length === 0
          && callExpressionsWithin(guarded.thenStatement, 'forkSession').length === 0,
        `C1 pending-repo caller ${callerBinding.enclosingFunction} must cut only the pending branch without swallowing C2 mid-session repo`,
      );
    } else {
      assert(
        callExpressionsWithin(caller, 'forkWorker').length === 0
          && callExpressionsWithin(caller, 'forkSession').length === 0,
        `C1 pending-repo caller ${callerBinding.enclosingFunction} must not retain a legacy fork path`,
      );
    }
  }

  for (const identifier of binding.forbiddenLegacyIdentifiers) {
    assert(
      !containsIdentifier(daemon, identifier)
        && !containsIdentifier(sourceFile('src/core/command-handler.ts'), identifier),
      `C1 legacy ordinary identifier ${identifier} returned to production`,
    );
  }

  for (const site of authoritySites.filter(site => (
    site.accessLane === 'session-runtime-current-adapter'
      && mandatoryOrdinaryAuthoritySelectors
        .get(site.sourceFile)?.includes(site.enclosingFunction)
  ))) {
    assert(
      assigned.get(siteIdentity(site)) === 'ordinary-im',
      `C1 Current ordinary authority site escaped migrated coverage: ${siteIdentity(site)}`,
    );
  }
}

function validateSessionLaneProductionBinding(binding) {
  const lane = sourceFile(binding.laneSource);
  const laneFactory = findNamedFunction(lane, binding.laneFactory);
  assert(
    importedModules(lane).length === 0,
    `A3 lane core ${binding.laneSource} must not import Current or effect capabilities`,
  );
  assert(
    awaitExpressionsWithin(lane).length === 0,
    `A3 lane core ${binding.laneSource} must not contain await`,
  );
  assert(
    callExpressionsWithin(laneFactory, 'assertShortTransition').length > 0,
    `A3 lane ${binding.laneSource}#${binding.laneFactory} lost its thenable guard`,
  );

  const currentLane = sourceFile(binding.currentLaneSource);
  assert(
    importedModules(currentLane).includes('./session-command-lane.js'),
    `A3 shared Current lane ${binding.currentLaneSource} must import the lane core`,
  );
  assert(
    callExpressionsWithin(currentLane, binding.laneFactory).length === 1,
    `A3 shared Current lane ${binding.currentLaneSource} must create exactly one process-local lane host`,
  );
  assert(
    containsIdentifier(currentLane, binding.sharedLaneExport),
    `A3 shared Current lane ${binding.currentLaneSource} must export ${binding.sharedLaneExport}`,
  );
  assert(
    awaitExpressionsWithin(currentLane).length === 0,
    `A3 shared Current lane ${binding.currentLaneSource} must not contain await`,
  );

  const sessionRuntime = sourceFile(binding.sessionRuntimeSource);
  findNamedFunction(sessionRuntime, binding.sessionRuntimeFactory);
  const sessionSubmit = findNamedFunction(sessionRuntime, binding.sessionSubmitFunction);
  const sessionTransition = findNamedFunction(
    sessionRuntime,
    binding.sessionTransitionFunction,
  );
  const sessionLaneCalls = callExpressionsWithin(sessionSubmit, 'commandLane.submit');
  const firstTransitionLaneCalls = sessionLaneCalls.filter(call => {
    const reducer = resolvedTransitionCallback(
      sessionRuntime,
      call.arguments[1],
      'A3 SessionRuntime candidate first-transition reducer',
    );
    return callExpressionsWithin(reducer, binding.sessionTransitionFunction).length === 1;
  });
  assert(
    firstTransitionLaneCalls.length === 1,
    `A3 SessionRuntime ${binding.sessionRuntimeSource}#${binding.sessionSubmitFunction} Session-targeted first transition must enter exactly one shared Session lane`,
  );
  const firstTransitionLaneCall = firstTransitionLaneCalls[0];
  const sessionReducer = resolvedTransitionCallback(
    sessionRuntime,
    firstTransitionLaneCall.arguments[1],
    'A3 SessionRuntime first-transition lane reducer',
  );
  assertSynchronousCallback(sessionReducer, 'A3 SessionRuntime first-transition lane reducer');
  const targetConditional = ancestorWithin(
    firstTransitionLaneCall,
    sessionSubmit,
    ts.isConditionalExpression,
  );
  assert(
    targetConditional
      && containsIdentifier(targetConditional.condition, 'laneSessionId')
      && nodeContains(targetConditional.whenTrue, firstTransitionLaneCall)
      && callExpressionsWithin(
        targetConditional.whenFalse,
        'enterLane',
      ).length === 1
      && callExpressionsWithin(sessionReducer, binding.sessionTransitionFunction).length === 1
      && containsIdentifier(sessionReducer, 'ownedWaitingControl')
      && containsIdentifier(firstTransitionLaneCall, 'sessionLaneAddress')
      && containsStringLiteral(sessionSubmit, 'session')
      && callExpressionsWithin(sessionSubmit, 'addressSlots.get').length === 1,
    `A3 SessionRuntime ${binding.sessionSubmitFunction} must route every resolved Session first transition through the logical Session address and leave only unresolved keyed routes outside`,
  );
  assert(
    callExpressionsWithin(sessionSubmit, 'keyedTriggerTurns.failClose').length === 1
      && callExpressionsWithin(firstTransitionLaneCall, 'keyedTriggerTurns.failClose').length === 0,
    'A3 must leave keyed route fail-close outside the resolved-Session lane as an explicit Target-A remainder',
  );

  const synchronousPortGuard = findNamedFunction(
    sessionRuntime,
    binding.synchronousPortGuardFunction,
  );
  assert(
    containsIdentifier(synchronousPortGuard, 'then')
      && callExpressionsWithin(synchronousPortGuard, 'Promise.resolve').length === 1,
    `A3 ${binding.synchronousPortGuardFunction} must reject thenable port results`,
  );
  const ordinaryBeginCalls = callExpressionsWithin(
    sessionTransition,
    'ordinaryIngress.begin',
  );
  assert(
    ordinaryBeginCalls.length === 1,
    'A3 ordinary ingress must have exactly one staged begin transition',
  );
  guardedPortCallback(
    sessionRuntime,
    sessionTransition,
    binding.synchronousPortGuardFunction,
    ordinaryBeginCalls[0],
    'A3 ordinary begin transition',
  );

  const ordinaryResume = findNamedFunction(
    sessionRuntime,
    binding.ordinaryResumeFunction,
  );
  const ordinaryResumePortCalls = callExpressionsWithin(
    ordinaryResume,
    'ordinaryIngress.resume',
  );
  assert(
    ordinaryResumePortCalls.length === 1,
    'A3 ordinary ingress must have exactly one staged resume transition',
  );
  guardedPortCallback(
    sessionRuntime,
    ordinaryResume,
    binding.synchronousPortGuardFunction,
    ordinaryResumePortCalls[0],
    'A3 ordinary resume transition',
  );

  const ordinaryEffectRunner = findNamedFunction(
    sessionRuntime,
    binding.ordinaryEffectRunnerFunction,
  );
  const ordinaryEffectRunnerCalls = callExpressionsWithin(
    sessionSubmit,
    binding.ordinaryEffectRunnerFunction,
  );
  assert(
    ordinaryEffectRunnerCalls.length === 1
      && ordinaryEffectRunnerCalls[0].pos > firstTransitionLaneCall.pos
      && sessionLaneCalls.every(call => {
        const reducer = resolvedTransitionCallback(
          sessionRuntime,
          call.arguments[1],
          'A3 SessionRuntime ordinary-effect exclusion reducer',
        );
        return !nodeContains(reducer, ordinaryEffectRunnerCalls[0]);
      }),
    'A3 ordinary effect runner must start once, after and outside the first-transition Session lane',
  );
  const ordinaryExecuteCalls = callExpressionsWithin(
    ordinaryEffectRunner,
    'ordinaryIngress.execute',
  );
  assert(
    ordinaryExecuteCalls.length === 1
      && !!ancestorWithin(ordinaryExecuteCalls[0], ordinaryEffectRunner, ts.isAwaitExpression),
    'A3 ordinary execute must be one awaited effect',
  );
  const ordinaryEffectLaneCalls = callExpressionsWithin(
    ordinaryEffectRunner,
    'commandLane.submit',
  );
  for (const call of ordinaryEffectLaneCalls) {
    const reducer = resolvedTransitionCallback(
      sessionRuntime,
      call.arguments[1],
      'A3 ordinary effect lane reducer',
    );
    assert(
      !nodeContains(reducer, ordinaryExecuteCalls[0]),
      'A3 ordinary execute must remain outside every Session lane reducer',
    );
  }
  const ordinaryResumeLaneCalls = ordinaryEffectLaneCalls.filter(call => {
    const reducer = resolvedTransitionCallback(
      sessionRuntime,
      call.arguments[1],
      'A3 ordinary candidate resume reducer',
    );
    return callExpressionsWithin(reducer, binding.ordinaryResumeFunction).length === 1;
  });
  assert(
    ordinaryResumeLaneCalls.length === 1,
    'A3 ordinary resume must re-enter exactly one shared Session lane',
  );
  const ordinaryResumeReducer = resolvedTransitionCallback(
    sessionRuntime,
    ordinaryResumeLaneCalls[0].arguments[1],
    'A3 ordinary resume lane reducer',
  );
  assertSynchronousCallback(ordinaryResumeReducer, 'A3 ordinary resume lane reducer');
  assert(
    containsIdentifier(ordinaryResumeLaneCalls[0], 'sessionLaneAddress')
      && containsIdentifier(ordinaryResumeLaneCalls[0], 'sessionId')
      && ordinaryExecuteCalls[0].pos < ordinaryResumeLaneCalls[0].pos,
    'A3 ordinary execute must finish outside the lane before resume re-enters the same Session address lane',
  );

  const currentSessionRuntime = sourceFile(binding.currentSessionRuntimeSource);
  const currentSessionFactory = findNamedFunction(
    currentSessionRuntime,
    binding.currentSessionRuntimeFactory,
  );
  const currentSessionComposition = callExpressionsWithin(
    currentSessionFactory,
    binding.sessionRuntimeFactory,
  );
  assert(
    currentSessionComposition.length === 1
      && containsIdentifier(currentSessionComposition[0], binding.sharedLaneExport)
      && containsIdentifier(currentSessionComposition[0], 'currentSessionLaneAddress'),
    'A3 Current SessionRuntime must inject the shared owner/epoch Session lane and address resolver',
  );
  assert(
    containsIdentifier(currentSessionComposition[0], 'ordinaryIngress')
      && containsIdentifier(currentSessionComposition[0], 'pendingRepoCompletion')
      && containsIdentifier(currentSessionComposition[0], 'portBindings')
      && !importedModules(currentSessionRuntime).includes('./current-ordinary-ingress.js'),
    'A3 Current SessionRuntime must bind injected ordinary/pending ports without creating the policy Adapter',
  );
  findNamedFunction(
    sourceFile(binding.ordinaryPolicySource),
    binding.ordinaryPolicyFactory,
  );

  const executorRuntime = sourceFile(binding.executorRuntimeSource);
  const executorFactory = findNamedFunction(executorRuntime, binding.executorRuntimeFactory);
  assert(
    awaitExpressionsWithin(executorRuntime).length === 0,
    `A3 executor Runtime ${binding.executorRuntimeSource} must not contain await`,
  );
  const executorLaneCalls = callExpressionsWithin(executorFactory, 'commandLane.submit');
  assert(
    executorLaneCalls.length === 2,
    `A3 executor Runtime ${binding.executorRuntimeSource} must lane both report and continuation resume`,
  );
  for (const method of ['report', 'resume']) {
    const fn = findNamedFunction(executorRuntime, method);
    const calls = callExpressionsWithin(fn, 'commandLane.submit');
    assert(calls.length === 1, `A3 executor ${method} must enter exactly one Session lane`);
    const reducer = resolvedTransitionCallback(
      executorRuntime,
      calls[0].arguments[1],
      `A3 executor ${method} reducer`,
    );
    assertSynchronousCallback(reducer, `A3 executor ${method} reducer`);
    assert(
      containsIdentifier(reducer, 'transition'),
      `A3 executor ${method} must run the caller's short authority transition inside the lane`,
    );
  }

  const currentExecutor = sourceFile(binding.currentExecutorAdapterSource);
  const currentExecutorFactory = findNamedFunction(
    currentExecutor,
    binding.currentExecutorAdapterFactory,
  );
  const currentExecutorComposition = callExpressionsWithin(
    currentExecutorFactory,
    binding.executorRuntimeFactory,
  );
  assert(
    currentExecutorComposition.length === 1
      && containsIdentifier(currentExecutorComposition[0], binding.sharedLaneExport)
      && containsIdentifier(currentExecutorComposition[0], 'currentSessionLaneAddressForKey'),
    'A3 Current executor Adapter must inject the same owner/epoch Session lane directory',
  );

  const worker = sourceFile(binding.workerSource);
  const handler = findNamedFunction(worker, binding.handlerFunction);
  const reportCalls = callExpressionsWithin(handler, 'sessionExecutorRuntime.report');
  const resumeCalls = callExpressionsWithin(handler, 'sessionExecutorRuntime.resume');
  assert(
    reportCalls.length === binding.reportCallCount,
    `A3 worker report route count drifted: expected ${binding.reportCallCount}, actual ${reportCalls.length}`,
  );
  assert(
    resumeCalls.length === binding.resumeCallCount,
    `A3 worker continuation route count drifted: expected ${binding.resumeCallCount}, actual ${resumeCalls.length}`,
  );
  for (const [index, call] of reportCalls.entries()) {
    assert(
      call.arguments.length === 3,
      `A3 worker report route ${index + 1} must bind decision and authority mutation in one lane transition`,
    );
    const transition = resolvedTransitionCallback(
      worker,
      call.arguments[2],
      `A3 worker report route ${index + 1}`,
    );
    assertSynchronousCallback(transition, `A3 worker report route ${index + 1}`);
  }
  for (const [index, call] of resumeCalls.entries()) {
    assert(
      call.arguments.length === 2,
      `A3 worker continuation route ${index + 1} must re-enter the lane with one short transition`,
    );
    const transition = resolvedTransitionCallback(
      worker,
      call.arguments[1],
      `A3 worker continuation route ${index + 1}`,
    );
    assertSynchronousCallback(transition, `A3 worker continuation route ${index + 1}`);
  }
  for (const kind of binding.observationKinds) {
    assert(
      reportCalls.some(call => containsStringLiteral(call, kind)),
      `A3 worker report routes do not lane ${kind}`,
    );
  }
  assert(
    awaitExpressionsWithin(handler).length > 0,
    'A3 worker handler must retain long executor/Lark/backend work outside its synchronous lane callbacks',
  );

  const keyedRemainder = binding.deferredPaths.find(
    path => path.id === 'keyed-route-admission-and-fail-close',
  );
  const keyedSource = sourceFile(keyedRemainder.sourceFile);
  const failClose = findNamedFunction(keyedSource, keyedRemainder.enclosingFunction);
  assert(
    awaitExpressionsWithin(failClose).length > 0
      && callExpressionsWithin(failClose, 'closeWorkerSession').length > 0,
    'A3 Target-A remainder must continue to identify keyed fail-close long lifecycle work',
  );
  const activationProviderEffect = binding.deferredPaths.find(
    path => path.id === 'activation-provider-effect-outside-lane',
  );
  findNamedFunction(
    sourceFile(activationProviderEffect.sourceFile),
    activationProviderEffect.enclosingFunction,
  );
}

function validateProjectionProductionBinding(binding) {
  const protocol = sourceFile(binding.protocolSource);
  const nextPosition = findNamedFunction(protocol, 'nextEventPosition');
  const snapshot = findNamedFunction(protocol, 'snapshot');
  assert(
    containsIdentifier(nextPosition, 'cursor'),
    'C3 Current protocol must advance its process-local cursor',
  );
  assert(
    containsIdentifier(snapshot, 'readiness') && containsIdentifier(snapshot, 'rows'),
    'C3 snapshot must carry readiness and rows',
  );
  for (const forbidden of ['storeEpoch', 'schemaVersion', 'topologyRevision']) {
    assert(
      !containsIdentifier(protocol, forbidden),
      `C3 Current runtime capability must not impersonate Store readiness via ${forbidden}`,
    );
  }

  const events = sourceFile(binding.eventSource);
  const publish = findNamedFunction(events, 'publish');
  assert(
    callExpressionsWithin(publish, 'nextEventPosition').length === 1,
    'C3 EventBus must stamp every Session event through one process position',
  );

  const runtime = sourceFile(binding.sessionRuntimeSource);
  assert(
    containsStringLiteral(runtime, 'dashboardSnapshot'),
    'C3 SessionProjection query must expose dashboardSnapshot',
  );
  const current = sourceFile(binding.currentProjectionSource);
  assert(
    callExpressionsWithin(current, 'dashboardProjectionProtocol.snapshot').length === 1,
    'C3 Current projection must rebuild rows and capture its cursor at one seam',
  );

  const ipc = sourceFile(binding.ipcSource);
  const readSnapshot = findNamedFunction(ipc, 'readCurrentDashboardSessionSnapshot');
  assert(
    callExpressionsWithin(readSnapshot, 'host.projection.read').length === 1
      && containsStringLiteral(readSnapshot, 'dashboardSnapshot'),
    'C3 daemon IPC snapshot must read through SessionProjection exactly once',
  );

  const aggregator = sourceFile(binding.aggregatorSource);
  const replace = findNamedFunction(aggregator, 'replaceSessionSnapshot');
  const applyEvent = findNamedFunction(aggregator, 'applyEvent');
  assert(
    callExpressionsWithin(replace, 'sessions.delete').length > 0,
    'C3 owner-slice replace must delete stale rows',
  );
  assert(
    containsIdentifier(applyEvent, 'projectionEpoch')
      && containsIdentifier(applyEvent, 'sequence')
      && containsStringLiteral(applyEvent, 'rebuildRequired'),
    'C3 incremental projection must detect epoch/sequence gaps',
  );
  const subscribe = findNamedFunction(aggregator, 'subscribeDaemon');
  assert(
    callExpressionsWithin(subscribe, 'rebuild').length > 0,
    'C3 daemon subscription must invoke authoritative rebuild on a gap/reconnect',
  );

  const dashboard = sourceFile(binding.dashboardSource);
  const replaceDaemon = findNamedFunction(dashboard, 'replaceDaemonSessionSnapshot');
  assert(
    callExpressionsWithin(replaceDaemon, 'aggregator.replaceSessionSnapshot').length === 1,
    'C3 Dashboard must replace, not additively hydrate, an owner Session slice',
  );
  const webStore = sourceFile(binding.webStoreSource);
  const bootstrap = findNamedFunction(webStore, 'bootstrap');
  assert(
    containsStringLiteral(bootstrap, 'projection.rebuilt')
      && callExpressionsWithin(bootstrap, 'reconcileSnapshot').length > 0,
    'C3 browser projection must reconcile after an authoritative owner-slice rebuild',
  );

  const daemonText = sourceFile(binding.daemonSource).getFullText();
  const initialProjection = daemonText.indexOf('await readCurrentDashboardSessionSnapshot()');
  const runtimeReady = daemonText.indexOf('currentDashboardProjectionProtocol.markReady()', initialProjection);
  const ipcReady = daemonText.indexOf('markIpcReady()', runtimeReady);
  assert(
    initialProjection >= 0 && runtimeReady > initialProjection && ipcReady > runtimeReady,
    'C3 daemon must build the initial projection before runtime ready and IPC release',
  );
}

function auditSessionRuntimeCoverageActive(ledger) {
  const coverageLedger = ledger ?? JSON.parse(readFileSync(ledgerPath, 'utf8'));
  validateLedgerSchema(coverageLedger);
  const facts = loadFacts();
  const actualAuthorityDigest = sha256(facts.authorityRaw);
  assert(
    coverageLedger.authorityInventory.sha256 === actualAuthorityDigest,
    `authority inventory digest drifted: expected ${coverageLedger.authorityInventory.sha256}, actual ${actualAuthorityDigest}`,
  );

  const assigned = new Map();
  const entryCounts = [];
  for (const entry of coverageLedger.coverage) {
    const selected = [];
    for (const selector of entry.selectors) {
      for (const site of selectAuthoritySites(selector, facts.sites, assigned)) {
        const identity = siteIdentity(site);
        const previous = assigned.get(identity);
        assert(!previous, `coverage selector overlap: ${identity} is claimed by ${previous} and ${entry.id}`);
        assigned.set(identity, entry.id);
        selected.push(site);
      }
    }
    if (entry.id === 'ordinary-im') validateOrdinaryAuthoritySelectors(entry.selectors);
    if (entry.id === 'dashboard-control') {
      validateDashboardControlAuthoritySelectors(entry.selectors);
    }
    if (entry.id === 'remaining-control-bypass') {
      validateRemainingControlBypassSelectors(entry.selectors);
    }
    validateAuthorityDisposition(entry, selected);
    const actual = selectedSiteFacts(selected);
    assert(
      entry.authoritySites.recordCount === actual.recordCount
        && entry.authoritySites.mutationCount === actual.mutationCount
        && entry.authoritySites.digest === actual.digest,
      `${entry.id} authority site binding drifted: expected ${JSON.stringify(entry.authoritySites)}, actual ${JSON.stringify(actual)}`,
    );
    entryCounts.push(`${entry.id}=${actual.mutationCount}`);
  }

  assert(
    assigned.size === facts.sites.length,
    `SessionRuntime coverage is incomplete: assigned ${assigned.size} of ${facts.sites.length} authority records`,
  );

  const assignedRawPublishers = new Map();
  const rawFactsByEntry = new Map();
  for (const entry of coverageLedger.coverage) {
    if (!entry.rawPublisherSelectors) continue;
    const selected = [];
    for (const selector of entry.rawPublisherSelectors) {
      for (const writer of selectRawPublishers(
        selector,
        facts.rawPublishers,
        assignedRawPublishers,
        facts.authorityClassifications,
      )) {
        const identity = rawPublisherIdentity(writer);
        const previous = assignedRawPublishers.get(identity);
        assert(
          !previous,
          `raw publisher selector overlap: ${identity} is claimed by ${previous} and ${entry.id}`,
        );
        assignedRawPublishers.set(identity, entry.id);
        selected.push(writer);
      }
    }
    validateRawPublisherDisposition(entry, selected, facts.authorityClassifications);
    const actual = selectedRawPublisherFacts(selected);
    rawFactsByEntry.set(entry.id, actual);
  }
  assert(
    assignedRawPublishers.size === facts.rawPublishers.length,
    `raw Session publisher coverage is incomplete: assigned ${assignedRawPublishers.size} of ${facts.rawPublishers.length}`,
  );
  const currentStoreApply = facts.rawPublishers.find(writer => (
    writer.sourceFile === 'src/services/session-store.ts'
    && writer.enclosingFunction === 'apply'
    && writer.authorityId === 'current-session-row'
  ));
  assert(currentStoreApply, 'CurrentSessionStore raw publisher src/services/session-store.ts#apply is missing');
  assert(
    assignedRawPublishers.get(rawPublisherIdentity(currentStoreApply))
      === 'current-session-store-adapter',
    'CurrentSessionStore apply raw publisher must remain in the migrated A1 adapter, not retained',
  );
  const ordinaryRollback = facts.rawPublishers.find(writer => (
    writer.sourceFile === 'src/services/session-store.ts'
      && writer.enclosingFunction === 'rollbackProvisionalSessionForOwnerStrict'
      && writer.authorityId === 'current-session-row'
  ));
  assert(ordinaryRollback, 'C1 provisional route rollback raw publisher is missing');
  assert(
    assignedRawPublishers.get(rawPublisherIdentity(ordinaryRollback)) === 'ordinary-im',
    'C1 provisional route rollback raw publisher must remain in ordinary-im, not D2 remainder',
  );
  for (const entry of coverageLedger.coverage) {
    const actual = rawFactsByEntry.get(entry.id);
    if (!actual) continue;
    assert(
      entry.authorityRawPublishers.recordCount === actual.recordCount
        && entry.authorityRawPublishers.publishSiteCount === actual.publishSiteCount
        && entry.authorityRawPublishers.digest === actual.digest,
      `${entry.id} raw publisher binding drifted: expected ${JSON.stringify(entry.authorityRawPublishers)}, actual ${JSON.stringify(actual)}`,
    );
  }
  const keyedTrigger = coverageLedger.coverage.find(entry => entry.id === 'keyed-trigger-start');
  validateMigratedProductionBinding(keyedTrigger.productionBinding, facts.sites);
  const ordinary = coverageLedger.coverage.find(entry => entry.id === 'ordinary-im');
  validateOrdinaryProductionBinding(ordinary.productionBinding, facts.sites, assigned);
  const dashboardControl = coverageLedger.coverage.find(
    entry => entry.id === 'dashboard-control',
  );
  validateControlProductionBinding(
    dashboardControl.productionBinding,
    facts.sites,
    assigned,
  );
  const executor = coverageLedger.coverage.find(entry => entry.id === 'executor-generation');
  validateExecutorProductionBinding(executor.productionBinding, facts.sites, assigned);
  const sessionLane = coverageLedger.coverage.find(entry => entry.id === 'per-session-command-lane');
  validateSessionLaneProductionBinding(sessionLane.productionBinding);
  const projection = coverageLedger.coverage.find(entry => entry.id === 'projection');
  validateProjectionProductionBinding(projection.productionBinding);
  const scheduler = coverageLedger.coverage.find(entry => entry.id === 'scheduler');
  validateSchedulerProductionBinding(scheduler.productionBinding, facts.sites);
  const activation = coverageLedger.coverage.find(entry => entry.id === 'activation-restore');
  validateActivationProductionBinding(activation.productionBinding);
  return { summary: entryCounts.join(', ') };
}

export function auditSessionRuntimeCoverage({ ledger, sourceOverrides } = {}) {
  // Mutation-oracle tests replace reviewed source in memory; the CLI never
  // supplies this seam and always audits files from the checkout.
  assert(
    sourceOverrides === undefined || isPlainObject(sourceOverrides),
    'sourceOverrides must be an object keyed by production source path',
  );
  const previousSourceOverrides = activeSourceOverrides;
  const previousOverrideParsedSources = activeOverrideParsedSources;
  activeSourceOverrides = sourceOverrides;
  activeOverrideParsedSources = new Map();
  try {
    return auditSessionRuntimeCoverageActive(ledger);
  } finally {
    activeSourceOverrides = previousSourceOverrides;
    activeOverrideParsedSources = previousOverrideParsedSources;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    const result = auditSessionRuntimeCoverage();
    console.log(`[session-runtime-coverage] verified: ${result.summary}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
