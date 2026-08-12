import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { auditSessionRuntimeCoverage } from '../scripts/audit-session-runtime-coverage.mjs';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, '..');
const auditScript = resolve(repoRoot, 'scripts/audit-session-runtime-coverage.mjs');
const ledgerPath = resolve(repoRoot, 'docs/architecture/session-runtime-coverage.json');

function checkedInLedger(): Record<string, any> {
  return JSON.parse(readFileSync(ledgerPath, 'utf8')) as Record<string, any>;
}

function cloneLedger(): Record<string, any> {
  return structuredClone(checkedInLedger());
}

function productionSource(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

function replaceAfter(
  source: string,
  anchor: string,
  before: string,
  after: string,
): string {
  const anchorIndex = source.indexOf(anchor);
  expect(anchorIndex, `missing mutation anchor ${anchor}`).toBeGreaterThanOrEqual(0);
  const beforeIndex = source.indexOf(before, anchorIndex);
  expect(beforeIndex, `missing mutation target after ${anchor}`).toBeGreaterThanOrEqual(0);
  return source.slice(0, beforeIndex) + after + source.slice(beforeIndex + before.length);
}

function auditWithSourceOverride(path: string, source: string): void {
  auditSessionRuntimeCoverage({
    ledger: cloneLedger(),
    sourceOverrides: { [path]: source },
  });
}

describe('SessionRuntime coverage ledger', () => {
  it('proves the checked-in migration and remaining-bypass coverage from source', () => {
    const result = spawnSync(process.execPath, [auditScript], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('[session-runtime-coverage] verified:');
  });

  it('gates compilation on the SessionRuntime coverage audit', () => {
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['audit:session-runtime'])
      .toBe('node scripts/audit-session-runtime-coverage.mjs');
    expect(pkg.scripts.build).toMatch(
      /audit:session-state && pnpm audit:session-runtime && node scripts\/clean-dist\.mjs/,
    );
  });

  it('rejects an invalid ledger schema before trusting its claims', () => {
    const ledger = cloneLedger();
    delete ledger.coverage[0].targetMilestone;
    expect(() => auditSessionRuntimeCoverage({ ledger }))
      .toThrow(/targetMilestone/);
  });

  it('rejects overlapping selectors instead of counting one authority site twice', () => {
    const ledger = cloneLedger();
    const ordinary = ledger.coverage.find((entry: any) => entry.id === 'ordinary-im');
    ordinary.selectors.push({ sourceFile: 'src/core/current-keyed-trigger-turn.ts' });
    expect(() => auditSessionRuntimeCoverage({ ledger }))
      .toThrow(/overlap/);
  });

  it('does not let the CurrentSessionStore apply publisher fall into retained remainder', () => {
    const ledger = cloneLedger();
    const runtimeStore = ledger.coverage.find(
      (entry: any) => entry.id === 'current-session-store-adapter',
    );
    runtimeStore.rawPublisherSelectors[0].enclosingFunctions = ['save'];
    expect(() => auditSessionRuntimeCoverage({ ledger }))
      .toThrow(/CurrentSessionStore.*apply.*migrated|raw publisher.*overlap/i);
  });

  it.each([
    {
      label: 'Session-owned persisted state',
      selector: {
        sourceFile: 'src/cli.ts',
        enclosingFunctions: ['abandonSessionOffline'],
        authorityIds: ['offline-session-mutation'],
      },
      violation: /retained.*session_owned_persisted/i,
    },
    {
      label: 'a direct caller mutation',
      selector: {
        sourceFile: 'src/core/riff-shutdown-detach.ts',
        enclosingFunctions: ['persistPreparedRiffShutdown'],
        accessLanes: ['direct-caller-mutation'],
        authorityIds: ['riff-lineage'],
      },
      violation: /retained.*direct-caller-mutation/i,
    },
    {
      label: 'the legacy SessionStore API lane',
      selector: {
        sourceFile: 'src/core/command-handler.ts',
        enclosingFunctions: ['upsertForkPanelCard'],
        accessLanes: ['session-store-api'],
        authorityIds: ['current-session-row'],
      },
      violation: /retained.*session-store-api/i,
    },
  ])('does not let retained coverage swallow $label', ({ selector, violation }) => {
    const ledger = cloneLedger();
    const retained = ledger.coverage.find((entry: any) => entry.id === 'path-specific-retained');
    retained.selectors = [selector];
    expect(() => auditSessionRuntimeCoverage({ ledger })).toThrow(violation);
  });

  it('does not call an ordinary legacy sessions publisher path-specific retained', () => {
    const ledger = cloneLedger();
    const retained = ledger.coverage.find((entry: any) => entry.id === 'path-specific-retained');
    retained.rawPublisherSelectors = [{
      sourceFile: 'src/services/session-store.ts',
      enclosingFunctions: ['save'],
      authorityIds: ['current-session-row'],
    }];
    expect(() => auditSessionRuntimeCoverage({ ledger }))
      .toThrow(/retained raw publisher.*session_owned_persisted/i);
  });

  it('does not let the projection partition claim Session authority', () => {
    const ledger = cloneLedger();
    const projection = ledger.coverage.find((entry: any) => entry.id === 'projection');
    projection.selectors = [{
      sourceFile: 'src/cli.ts',
      enclosingFunctions: ['abandonSessionOffline'],
      authorityIds: ['offline-session-mutation'],
    }];
    expect(() => auditSessionRuntimeCoverage({ ledger }))
      .toThrow(/projection.*session_owned_persisted/i);
  });

  it('pins migrated C3 to the reviewed projection/readiness production seams', () => {
    const ledger = cloneLedger();
    const projection = ledger.coverage.find((entry: any) => entry.id === 'projection');
    projection.productionBinding.aggregatorSource = 'src/dashboard/registry.ts';
    expect(() => auditSessionRuntimeCoverage({ ledger }))
      .toThrow(/projection\.productionBinding\.aggregatorSource/);
  });

  it('rejects a Dashboard selector whose exact Current symbol disappeared', () => {
    const ledger = cloneLedger();
    const control = ledger.coverage.find((entry: any) => entry.id === 'dashboard-control');
    control.selectors[0].enclosingFunctions = ['removedControlEntrypoint'];
    expect(() => auditSessionRuntimeCoverage({ ledger }))
      .toThrow(/dashboard-control selectors.*exact reviewed/i);
  });

  it('locks C2 to a migrated Dashboard caller cut plus a non-zero direct remainder', () => {
    const ledger = cloneLedger();
    const dashboard = ledger.coverage.find((entry: any) => entry.id === 'dashboard-control');
    const remaining = ledger.coverage.find(
      (entry: any) => entry.id === 'remaining-control-bypass',
    );
    const projection = ledger.coverage.find((entry: any) => entry.id === 'projection');

    expect(ledger.coverage.some((entry: any) => entry.id === 'control')).toBe(false);
    expect(dashboard).toMatchObject({
      targetMilestone: 'C2',
      disposition: 'migrated',
      authoritySites: { recordCount: 8, mutationCount: 8 },
      productionBinding: { operationReceiptDurability: 'daemonEpoch' },
    });
    expect(remaining).toMatchObject({
      targetMilestone: 'C2',
      disposition: 'remaining',
      authoritySites: { recordCount: 86, mutationCount: 86 },
    });
    expect(remaining.authoritySites.mutationCount).toBeGreaterThan(0);
    expect(remaining.productionBinding).toBeUndefined();
    expect(projection).toMatchObject({
      targetMilestone: 'C3',
      disposition: 'migrated',
      authoritySites: { recordCount: 23, mutationCount: 23 },
    });
  });

  it.each([
    ['src/core/current-dashboard-route-opening.ts', 'inspectCurrentDashboardRoute'],
    ['src/core/current-ordinary-route-registry.ts', 'inspectRelocationTarget'],
    ['src/core/current-session-control.ts', 'convergeAsyncTriggerFault'],
    ['src/core/current-session-control.ts', 'execute'],
    ['src/core/session-manager.ts', 'spawnDashboardSession'],
  ])('rejects deleting exact C2 authority %s#%s', (sourceFile, enclosingFunction) => {
    const ledger = cloneLedger();
    const dashboard = ledger.coverage.find((entry: any) => entry.id === 'dashboard-control');
    const selector = dashboard.selectors.find((candidate: any) => (
      candidate.sourceFile === sourceFile
      && candidate.enclosingFunctions?.includes(enclosingFunction)
    ));
    if (selector.enclosingFunctions.length === 1) {
      dashboard.selectors = dashboard.selectors.filter((candidate: any) => candidate !== selector);
    } else {
      selector.enclosingFunctions = selector.enclosingFunctions
        .filter((name: string) => name !== enclosingFunction);
    }

    expect(() => auditSessionRuntimeCoverage({ ledger }))
      .toThrow(/dashboard-control selectors.*exact reviewed/i);
  });

  it('rejects a whole-file Dashboard authority selector', () => {
    const ledger = cloneLedger();
    const dashboard = ledger.coverage.find((entry: any) => entry.id === 'dashboard-control');
    delete dashboard.selectors[0].enclosingFunctions;

    expect(() => auditSessionRuntimeCoverage({ ledger }))
      .toThrow(/dashboard-control selectors must name only exact reviewed functions/i);
  });

  it('requires the trigger-result convergence route and its trigger-derived identity', () => {
    const withoutRoute = cloneLedger();
    const dashboard = withoutRoute.coverage.find(
      (entry: any) => entry.id === 'dashboard-control',
    );
    dashboard.productionBinding.routes = dashboard.productionBinding.routes
      .filter((route: any) => route.path !== '/api/sessions/:sessionId/trigger-result');
    expect(() => auditSessionRuntimeCoverage({ ledger: withoutRoute }))
      .toThrow(/routes must cover every reviewed Dashboard mutation route/i);

    const wrongIdentity = cloneLedger();
    const triggerRoute = wrongIdentity.coverage
      .find((entry: any) => entry.id === 'dashboard-control')
      .productionBinding.routes
      .find((route: any) => route.path === '/api/sessions/:sessionId/trigger-result');
    triggerRoute.identitySource = 'caller-supplied';
    expect(() => auditSessionRuntimeCoverage({ ledger: wrongIdentity }))
      .toThrow(/trigger-result\.identitySource must be derived-trigger-id/i);
  });

  it('rejects weakening the C2 direct Current capability fence', () => {
    const ledger = cloneLedger();
    const dashboard = ledger.coverage.find((entry: any) => entry.id === 'dashboard-control');
    dashboard.productionBinding.forbiddenCallerCalls =
      dashboard.productionBinding.forbiddenCallerCalls
        .filter((call: string) => call !== 'getActiveSessionsRegistry');

    expect(() => auditSessionRuntimeCoverage({ ledger }))
      .toThrow(/forbiddenCallerCalls.*exact direct Current capability fence/i);
  });

  it('reverse-censuses every caller-operation-bearing Dashboard route', () => {
    const path = 'src/core/dashboard-ipc-server.ts';
    const source = productionSource(path);
    const mutated = `${source}\n` + [
      "ipcRoute('POST', '/api/sessions/:sessionId/unreviewed-control', async (req, res, params) => {",
      '  const operationId = sessionOperationId(req, {});',
      '  await dashboardSessionRuntimeSubmitter?.({',
      "    target: { kind: 'externalSession', sessionId: params.sessionId },",
      '    idempotencyKey: operationId.value,',
      "    command: { kind: 'control.mutate', input: { kind: 'close' } },",
      '  });',
      '  jsonRes(res, 200, { ok: true });',
      '});',
    ].join('\n');

    expect(() => auditWithSourceOverride(path, mutated))
      .toThrow(/caller-operation route census.*unreviewed-control/i);
  });

  it('scans every Dashboard route callback for direct-write capabilities', () => {
    const path = 'src/core/dashboard-ipc-server.ts';
    const source = productionSource(path);
    const mutated = replaceAfter(
      source,
      "ipcRoute('GET', '/__health'",
      "(_req, res) => {",
      "(_req, res) => {\n  sessionStore.updateSession('unreviewed' as never, {} as never);",
    );

    expect(() => auditWithSourceOverride(path, mutated))
      .toThrow(/Dashboard route GET \/__health.*forbidden direct-write capability.*sessionStore\.updateSession/i);
  });

  it('proves each caller operation identity reaches its reviewed command sink', () => {
    const path = 'src/core/dashboard-ipc-server.ts';
    const source = productionSource(path);
    const mutated = replaceAfter(
      source,
      "ipcRoute('POST', '/api/sessions/:sessionId/close'",
      'idempotencyKey: operationId.value,',
      "idempotencyKey: 'constant-operation-id',",
    );

    expect(() => auditWithSourceOverride(path, mutated))
      .toThrow(/POST \/api\/sessions\/:sessionId\/close.*operationId\.value.*sink/i);
  });

  it('proves the external running receipt is visible before execution can start', () => {
    const path = 'src/core/current-dashboard-session-command-client.ts';
    const source = productionSource(path);
    let mutated = replaceAfter(
      source,
      'const submit = async',
      'const terminal = Promise.resolve().then(() => executeExternal(',
      'const terminal = executeExternal(',
    );
    mutated = replaceAfter(
      mutated,
      'const terminal = executeExternal(',
      '      externalInput,\n    ));',
      '      externalInput,\n    );',
    );

    expect(() => auditWithSourceOverride(path, mutated))
      .toThrow(/running receipt.*before.*executeExternal|executeExternal.*deferred microtask/i);
  });

  it('rejects an external projection started before the running receipt', () => {
    const path = 'src/core/current-dashboard-session-command-client.ts';
    const source = productionSource(path);
    const mutated = replaceAfter(
      source,
      'const submit = async',
      'const terminal = Promise.resolve().then(() => executeExternal(',
      "await host.projection.read({ kind: 'session', sessionId: input.target.sessionId });\n    const terminal = Promise.resolve().then(() => executeExternal(",
    );

    expect(() => auditWithSourceOverride(path, mutated))
      .toThrow(/running receipt.*before.*projection|projection.*deferred microtask/i);
  });

  it('rejects yielding to the execution microtask before publishing the running receipt', () => {
    const path = 'src/core/current-dashboard-session-command-client.ts';
    const source = productionSource(path);
    const mutated = replaceAfter(
      source,
      'const submit = async',
      '    externalAttempts.set(key, { requestHash, state:',
      "    await Promise.resolve();\n    externalAttempts.set(key, { requestHash, state:",
    );

    expect(() => auditWithSourceOverride(path, mutated))
      .toThrow(/running receipt.*immediately after.*microtask|before yielding.*microtask/i);
  });

  it('rejects a control effect executed from inside a Session lane callback', () => {
    const path = 'src/core/session-runtime.ts';
    const source = productionSource(path);
    const mutated = replaceAfter(
      source,
      'const runControlMutationEffects = async',
      'await port.execute(step.intent)',
      'await commandLane.submit(sessionLaneAddress(step.sessionId), async () => await port.execute(step.intent))',
    );

    expect(() => auditWithSourceOverride(path, mutated))
      .toThrow(/control mutation.*lane callback.*port\.execute|lane callback.*must not.*await/i);
  });

  it('rejects dispatching the control effect runner from inside the Session lane', () => {
    const path = 'src/core/session-runtime.ts';
    const source = productionSource(path);
    const mutated = replaceAfter(
      source,
      "if (result.kind === 'controlMutationEffect')",
      'return await runControlMutationEffects(result)',
      'return await commandLane.submit(sessionLaneAddress(result.sessionId), () => runControlMutationEffects(result))',
    );

    expect(() => auditWithSourceOverride(path, mutated))
      .toThrow(/control mutation effect runner.*outside.*Session lane/i);
  });

  it('requires reopen cleanup to share the reviewed Current route admission', () => {
    const ledger = cloneLedger();
    const dashboard = ledger.coverage.find((entry: any) => entry.id === 'dashboard-control');
    dashboard.productionBinding.sharedRouteAdmissionConsumers =
      dashboard.productionBinding.sharedRouteAdmissionConsumers
        .filter((consumer: any) => (
          consumer.sourceFile !== 'src/core/current-reopen-route-admission.ts'
        ));

    expect(() => auditSessionRuntimeCoverage({ ledger }))
      .toThrow(/sharedRouteAdmissionConsumers must cover every reviewed route producer/i);
  });

  it('rejects a drifted shared route-admission reservation count', () => {
    const ledger = cloneLedger();
    const dashboard = ledger.coverage.find((entry: any) => entry.id === 'dashboard-control');
    const scheduled = dashboard.productionBinding.sharedRouteAdmissionConsumers
      .find((consumer: any) => consumer.sourceFile === 'src/core/current-scheduled-fire.ts');
    scheduled.reservationCount += 1;

    expect(() => auditSessionRuntimeCoverage({ ledger }))
      .toThrow(/current-scheduled-fire.*reservationCount must be 2/i);
  });

  it.each([
    ['Runtime effect runner', 'mutationEffectRunner'],
    ['Runtime resume transition', 'mutationResumeFunction'],
    ['A4 daemon coordinator', 'daemonActivationFactory'],
    ['Dashboard create receipt host', 'createOperationHostFactory'],
    ['Dashboard operation identity reader', 'aggregatorOperationIdReader'],
    ['browser operation coordinator', 'webOperationCoordinator'],
    ['Sessions card operation identity', 'sessionsCardBuilder'],
    ['shared cwd Current publisher', 'cwdCurrentPublisher'],
  ])('rejects deleting the C2 production proof for %s', (_label, field) => {
    const ledger = cloneLedger();
    const dashboard = ledger.coverage.find((entry: any) => entry.id === 'dashboard-control');
    dashboard.productionBinding[field] = `removed-${field}`;

    expect(() => auditSessionRuntimeCoverage({ ledger }))
      .toThrow(new RegExp(`dashboard-control\\.productionBinding\\.${field}`, 'i'));
  });

  it('binds coverage claims to the reviewed authority inventory digest', () => {
    const ledger = cloneLedger();
    ledger.authorityInventory.sha256 = '0'.repeat(64);
    expect(() => auditSessionRuntimeCoverage({ ledger }))
      .toThrow(/authority inventory digest/i);
  });

  it('rejects a forbidden capability inside the migrated production branch', () => {
    const ledger = cloneLedger();
    const migrated = ledger.coverage.find((entry: any) => entry.id === 'keyed-trigger-start');
    migrated.productionBinding.forbiddenCalls.push('currentSessionRuntimeHost');
    expect(() => auditSessionRuntimeCoverage({ ledger }))
      .toThrow(/forbidden.*currentSessionRuntimeHost/i);
  });

  it('locks C4 scheduler authority to 20 migrated mutations and 13 retained projections', () => {
    const ledger = cloneLedger();
    const migrated = ledger.coverage.find((entry: any) => entry.id === 'scheduler');
    const retained = ledger.coverage.find(
      (entry: any) => entry.id === 'scheduler-retained-projection',
    );

    expect(migrated).toMatchObject({
      targetMilestone: 'C4',
      disposition: 'migrated',
      authoritySites: { recordCount: 20, mutationCount: 20 },
      productionBinding: {
        commandKind: 'scheduled.fire',
        durability: 'processLocal',
      },
    });
    expect(retained).toMatchObject({
      targetMilestone: 'C4',
      disposition: 'retained',
      authoritySites: { recordCount: 13, mutationCount: 13 },
    });
    expect(() => auditSessionRuntimeCoverage({ ledger })).not.toThrow();
  });

  it('rejects weakening the C4 scheduler direct-Session capability fence', () => {
    const ledger = cloneLedger();
    const scheduler = ledger.coverage.find((entry: any) => entry.id === 'scheduler');
    scheduler.productionBinding.forbiddenProducerCalls =
      scheduler.productionBinding.forbiddenProducerCalls
        .filter((call: string) => call !== 'sessionStore.updateSession');

    expect(() => auditSessionRuntimeCoverage({ ledger }))
      .toThrow(/forbiddenProducerCalls.*exact direct Session capabilities/i);
  });

  it('rejects weakening the C4 scheduled.fire production binding', () => {
    const ledger = cloneLedger();
    const scheduler = ledger.coverage.find((entry: any) => entry.id === 'scheduler');
    scheduler.productionBinding.commandKind = 'legacy.schedule.execute';

    expect(() => auditSessionRuntimeCoverage({ ledger }))
      .toThrow(/scheduler\.productionBinding\.commandKind must be scheduled\.fire/i);
  });

  it('does not let migrated executor coverage swallow the rest of setupWorkerHandlers', () => {
    const ledger = cloneLedger();
    const executor = ledger.coverage.find((entry: any) => entry.id === 'executor-generation');
    const workerSelector = executor.selectors.find(
      (selector: any) => selector.sourceFile === 'src/core/worker-pool.ts',
    );
    delete workerSelector.accessLanes;
    expect(() => auditSessionRuntimeCoverage({ ledger }))
      .toThrow(/executor-generation.*exact.*session-executor-runtime-adapter.*access lane/i);
  });

  it('requires every executor observation at the migrated production boundary', () => {
    const ledger = cloneLedger();
    const executor = ledger.coverage.find((entry: any) => entry.id === 'executor-generation');
    executor.productionBinding.observationKinds = executor.productionBinding.observationKinds
      .filter((kind: string) => kind !== 'workerExit');
    expect(() => auditSessionRuntimeCoverage({ ledger }))
      .toThrow(/observationKinds.*every executor observation/i);
  });

  it('binds A3 ordering structurally without stealing A1/A2 authority sites', () => {
    const ledger = cloneLedger();
    const lane = ledger.coverage.find((entry: any) => entry.id === 'per-session-command-lane');
    const ordinary = ledger.coverage.find((entry: any) => entry.id === 'ordinary-im');

    expect(lane).toBeDefined();
    expect(lane.selectors).toEqual([]);
    expect(lane.authoritySites).toEqual({
      recordCount: 0,
      mutationCount: 0,
      digest: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    });
    expect(lane.productionBinding).toMatchObject({
      sessionTransitionFunction: 'run',
      ordinaryEffectRunnerFunction: 'runOrdinaryEffects',
      ordinaryResumeFunction: 'resumeOrdinaryAttempt',
      synchronousPortGuardFunction: 'invokeSynchronousPort',
      ordinaryPolicySource: 'src/core/current-ordinary-ingress.ts',
      ordinaryPolicyFactory: 'createCurrentOrdinaryIngressPort',
      ordinaryProductionWired: true,
    });
    expect(ordinary).toMatchObject({
      targetMilestone: 'C1',
      disposition: 'migrated',
    });
    expect(ordinary.productionBinding).toMatchObject({
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
    expect(ordinary.rawPublisherSelectors).toEqual([{
      sourceFile: 'src/services/session-store.ts',
      enclosingFunctions: ['rollbackProvisionalSessionForOwnerStrict'],
      authorityIds: ['current-session-row'],
    }]);
    expect(() => auditSessionRuntimeCoverage({ ledger })).not.toThrow();
  });

  it.each([
    ['Session first-transition lane', 'sessionTransitionFunction', 'run'],
    ['ordinary effect outside the lane', 'ordinaryEffectRunnerFunction', 'runOrdinaryEffects'],
    ['ordinary resume into the lane', 'ordinaryResumeFunction', 'resumeOrdinaryAttempt'],
  ])('rejects deleting the %s proof', (_label, field, expectedSymbol) => {
    const ledger = cloneLedger();
    const lane = ledger.coverage.find((entry: any) => entry.id === 'per-session-command-lane');
    lane.productionBinding[field] = `removed${expectedSymbol}`;

    expect(() => auditSessionRuntimeCoverage({ ledger }))
      .toThrow(new RegExp(`${field} must be ${expectedSymbol}`, 'i'));
  });

  it('rejects deleting the ordinary begin/resume synchronous guard proof', () => {
    const ledger = cloneLedger();
    const lane = ledger.coverage.find((entry: any) => entry.id === 'per-session-command-lane');
    lane.productionBinding.synchronousPortGuardFunction = 'removedSynchronousPortGuard';

    expect(() => auditSessionRuntimeCoverage({ ledger }))
      .toThrow(/synchronousPortGuardFunction must be invokeSynchronousPort/i);
  });

  it('rejects deleting the ordinary Current production-wiring claim', () => {
    const ledger = cloneLedger();
    const lane = ledger.coverage.find((entry: any) => entry.id === 'per-session-command-lane');
    lane.productionBinding.ordinaryProductionWired = false;

    expect(() => auditSessionRuntimeCoverage({ ledger }))
      .toThrow(/ordinaryProductionWired.*true|ordinary.*must remain production-wired/i);
  });

  it.each([
    {
      label: 'stable daemon Host',
      field: 'daemonHostFactory',
    },
    {
      label: 'full ingress port',
      field: 'ingressDaemonFactory',
    },
    {
      label: 'route-opening port',
      field: 'routeOpeningFactory',
    },
    {
      label: 'pending first-start submit',
      field: 'pendingRepoSubmitFunction',
    },
    {
      label: 'pending first-start dispatch',
      field: 'pendingRepoDispatchFunction',
    },
    {
      label: 'ordinary queued-activation recovery',
      field: 'ordinaryQueuedActivationRecoveryFunction',
    },
  ])('rejects deleting the ordinary production proof for $label', ({ field }) => {
    const ledger = cloneLedger();
    const ordinary = ledger.coverage.find((entry: any) => entry.id === 'ordinary-im');
    delete ordinary.productionBinding[field];

    expect(() => auditSessionRuntimeCoverage({ ledger }))
      .toThrow(new RegExp(`ordinary-im\\.productionBinding\\.${field}`, 'i'));
  });

  it.each([
    {
      sourceFile: 'src/core/current-ordinary-ingress-production.ts',
      enclosingFunction: 'apply',
    },
    {
      sourceFile: 'src/core/current-pending-repo-completion-production.ts',
      enclosingFunction: 'dispatchWorker',
    },
    {
      sourceFile: 'src/core/current-pending-repo-completion.ts',
      enclosingFunction: 'clearExactPendingClaim',
    },
    {
      sourceFile: 'src/core/current-pending-repo-completion.ts',
      enclosingFunction: 'rollbackProvenWorkerRefusalCandidate',
    },
  ])(
    'rejects deleting exact ordinary Current authority $sourceFile#$enclosingFunction',
    ({ sourceFile, enclosingFunction }) => {
      const ledger = cloneLedger();
      const ordinary = ledger.coverage.find((entry: any) => entry.id === 'ordinary-im');
      const selector = ordinary.selectors.find((candidate: any) => (
        candidate.sourceFile === sourceFile
        && candidate.enclosingFunctions?.includes(enclosingFunction)
      ));
      if (selector.enclosingFunctions.length === 1) {
        ordinary.selectors = ordinary.selectors.filter(
          (candidate: any) => candidate !== selector,
        );
      } else {
        selector.enclosingFunctions = selector.enclosingFunctions
          .filter((name: string) => name !== enclosingFunction);
      }

      expect(() => auditSessionRuntimeCoverage({ ledger }))
        .toThrow(/ordinary-im selectors.*exact Current authority partition/i);
    },
  );

  it.each([
    'prepareQueuedActivationRecoveryFork',
    'promoteQueuedActivationTailTyped',
  ])('keeps A4 tail authority in its exact typed selector: %s', (enclosingFunction) => {
    const ledger = cloneLedger();
    const activation = ledger.coverage.find((entry: any) => entry.id === 'activation-restore');
    const selector = activation.selectors.find((candidate: any) => (
      candidate.sourceFile === 'src/core/worker-pool.ts'
      && candidate.enclosingFunctions?.includes(enclosingFunction)
    ));
    selector.enclosingFunctions = selector.enclosingFunctions
      .filter((name: string) => name !== enclosingFunction);

    expect(() => auditSessionRuntimeCoverage({ ledger }))
      .toThrow(/activation-restore.*exact typed tail authority selector/i);
  });

  it('locks the reviewed A4 343-site partition and migrated production seam', () => {
    const ledger = cloneLedger();
    const activation = ledger.coverage.find((entry: any) => entry.id === 'activation-restore');

    expect(activation).toMatchObject({
      disposition: 'migrated',
      authoritySites: { recordCount: 225, mutationCount: 226 },
      productionBinding: {
        reviewedLegacyPartition: {
          originalMutationCount: 343,
          migratedProviderMutationCount: 226,
          reclassifiedOtherMutationCount: 117,
          explicitLifecycleControl: 53,
          activeRouteMaintenance: 6,
          freshSessionCreation: 30,
          generationPrecommitCreation: 28,
        },
      },
    });
  });

  it('rejects deleting a reviewed A4 production caller cut', () => {
    const ledger = cloneLedger();
    const activation = ledger.coverage.find((entry: any) => entry.id === 'activation-restore');
    activation.productionBinding.callerCuts = activation.productionBinding.callerCuts
      .filter((caller: any) => caller.enclosingFunction !== 'ensureTerminalWorkerPort');

    expect(() => auditSessionRuntimeCoverage({ ledger }))
      .toThrow(/callerCuts.*every reviewed activation caller/i);
  });

  it('rejects changing the A4 BotId/epoch coordinator composition', () => {
    const ledger = cloneLedger();
    const activation = ledger.coverage.find((entry: any) => entry.id === 'activation-restore');
    activation.productionBinding.daemonFactory = 'currentSessionRuntimeHost';

    expect(() => auditSessionRuntimeCoverage({ ledger }))
      .toThrow(/activation-restore\.productionBinding\.daemonFactory/i);
  });

  it('rejects clearing backend quarantine while retirement is only prepared', () => {
    const path = 'src/core/current-session-activation.ts';
    const source = productionSource(path);
    const mutated = replaceAfter(
      source,
      'retire(request): SessionRetirementOutcome',
      'quarantine.pendingRetirements.add(key);',
      'quarantines.delete(request.sessionId);',
    );

    expect(() => auditWithSourceOverride(path, mutated))
      .toThrow(/retirement prepare.*without clearing backend quarantine/i);
  });

  it('rejects dropping prior backend-unknown evidence after a notApplied provider result', () => {
    const path = 'src/core/current-session-activation.ts';
    const source = productionSource(path);
    const mutated = replaceAfter(
      source,
      'settleRetirement(request): SessionRetirementSettlementOutcome',
      '!quarantine.backendUnknown && quarantine.pendingRetirements.size === 0',
      'quarantine.pendingRetirements.size === 0',
    );

    expect(() => auditWithSourceOverride(path, mutated))
      .toThrow(/notApplied settlement.*preserve prior backend-unknown evidence/i);
  });

  it('rejects making an unknown retirement settlement reactivatable', () => {
    const path = 'src/core/current-session-activation.ts';
    const source = productionSource(path);
    const mutated = replaceAfter(
      source,
      'settleRetirement(request): SessionRetirementSettlementOutcome',
      'quarantine.backendUnknown = true;',
      'quarantine.backendUnknown = false;',
    );

    expect(() => auditWithSourceOverride(path, mutated))
      .toThrow(/unknown retirement settlement.*remain sticky/i);
  });

  it('rejects deleting an existing/route one-submit caller proof', () => {
    const ledger = cloneLedger();
    const ordinary = ledger.coverage.find((entry: any) => entry.id === 'ordinary-im');
    ordinary.productionBinding.ordinaryCallers = ordinary.productionBinding.ordinaryCallers
      .filter((caller: any) => caller.enclosingFunction !== 'handleThreadReplyAdmitted');

    expect(() => auditSessionRuntimeCoverage({ ledger }))
      .toThrow(/ordinaryCallers.*handleThreadReplyAdmitted|every ordinary caller/i);
  });

  it('rejects deleting a pending first-start caller cut', () => {
    const ledger = cloneLedger();
    const ordinary = ledger.coverage.find((entry: any) => entry.id === 'ordinary-im');
    ordinary.productionBinding.pendingRepoCallerCuts = ordinary.productionBinding.pendingRepoCallerCuts
      .filter((caller: any) => caller.enclosingFunction !== 'handleCardAction');

    expect(() => auditSessionRuntimeCoverage({ ledger }))
      .toThrow(/pendingRepoCallerCuts.*handleCardAction|every pending-repo first-start caller/i);
  });

  it('rejects deleting the legacy ordinary-tail regression fence', () => {
    const ledger = cloneLedger();
    const ordinary = ledger.coverage.find((entry: any) => entry.id === 'ordinary-im');
    ordinary.productionBinding.forbiddenLegacyIdentifiers = [];

    expect(() => auditSessionRuntimeCoverage({ ledger }))
      .toThrow(/forbiddenLegacyIdentifiers.*(exact legacy|must not be empty)|legacy ordinary/i);
  });

  it('keeps ordinary and Dashboard selectors exact while shared providers stay remaining', () => {
    const ledger = cloneLedger();
    const ordinary = ledger.coverage.find((entry: any) => entry.id === 'ordinary-im');
    const dashboard = ledger.coverage.find((entry: any) => entry.id === 'dashboard-control');
    const remaining = ledger.coverage.find(
      (entry: any) => entry.id === 'remaining-control-bypass',
    );

    expect(ordinary.selectors.every((selector: any) => (
      selector.accessLanes?.length === 1
      && selector.accessLanes[0] === 'session-runtime-current-adapter'
    ))).toBe(true);
    expect(ordinary.selectors.some((selector: any) => (
      selector.sourceFile === 'src/daemon.ts'
      && selector.enclosingFunctions?.some((name: string) => (
        name === 'handleThreadReplyAdmitted'
        || name === 'runCurrentOrdinaryOpeningPostCommit'
      ))
    ))).toBe(false);
    expect(dashboard.selectors.every((selector: any) => (
      selector.enclosingFunctions?.length > 0
      && selector.accessLanes?.length === 1
      && selector.accessLanes[0] === 'session-runtime-current-adapter'
    ))).toBe(true);
    expect(dashboard.selectors.some((selector: any) => (
      selector.sourceFile === 'src/core/session-cwd.ts'
    ))).toBe(false);
    expect(remaining.selectors.every((selector: any) => (
      selector.enclosingFunctions?.length > 0
      && selector.accessLanes === undefined
    ))).toBe(true);
    expect(remaining.selectors.some((selector: any) => (
      selector.sourceFile === 'src/im/lark/card-handler.ts'
      && selector.enclosingFunctions?.includes('commitRepoSelection')
    ))).toBe(true);
    expect(remaining.selectors.some((selector: any) => (
      selector.sourceFile === 'src/core/session-cwd.ts'
      && selector.enclosingFunctions?.includes('assignWorkingDirectory')
      && selector.enclosingFunctions?.includes('repinSessionWorkingDir')
    ))).toBe(true);
  });

  it('rejects deleting the shared Current lane composition seam', () => {
    const ledger = cloneLedger();
    const lane = ledger.coverage.find((entry: any) => entry.id === 'per-session-command-lane');
    lane.productionBinding.currentLaneSource = 'src/core/session-command-lane.ts';

    expect(() => auditSessionRuntimeCoverage({ ledger }))
      .toThrow(/currentLaneSource.*shared Current lane/i);
  });

  it('rejects a report route that loses its synchronous lane transition', () => {
    const ledger = cloneLedger();
    const lane = ledger.coverage.find((entry: any) => entry.id === 'per-session-command-lane');
    lane.productionBinding.reportCallCount -= 1;

    expect(() => auditSessionRuntimeCoverage({ ledger }))
      .toThrow(/reportCallCount.*exact report routes/i);
  });

  it('keeps keyed fail-close remaining while A4 provider effects stay outside the lane', () => {
    const ledger = cloneLedger();
    const lane = ledger.coverage.find((entry: any) => entry.id === 'per-session-command-lane');
    expect(lane.productionBinding.deferredPaths).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'keyed-route-admission-and-fail-close',
        targetMilestone: 'Target-A',
      }),
      expect.objectContaining({
        id: 'activation-provider-effect-outside-lane',
        targetMilestone: 'A4',
      }),
    ]));
    lane.productionBinding.deferredPaths = lane.productionBinding.deferredPaths
      .filter((path: any) => path.id !== 'keyed-route-admission-and-fail-close');

    expect(() => auditSessionRuntimeCoverage({ ledger }))
      .toThrow(/deferredPaths.*keyed fail-close/i);
  });
});
