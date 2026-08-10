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

  it('rejects a selector whose named production symbol disappeared', () => {
    const ledger = cloneLedger();
    const control = ledger.coverage.find((entry: any) => entry.id === 'control');
    control.selectors[0].enclosingFunctions = ['removedControlEntrypoint'];
    expect(() => auditSessionRuntimeCoverage({ ledger }))
      .toThrow(/selector.*matched no authority sites|missing.*removedControlEntrypoint/i);
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

  it('keeps ordinary migrated selectors exact and mid-session repo in C2', () => {
    const ledger = cloneLedger();
    const ordinary = ledger.coverage.find((entry: any) => entry.id === 'ordinary-im');
    const control = ledger.coverage.find((entry: any) => entry.id === 'control');

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
    expect(control.selectors.some((selector: any) => (
      selector.sourceFile === 'src/im/lark/card-handler.ts'
      && selector.enclosingFunctions?.includes('commitRepoSelection')
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

  it('keeps keyed fail-close and long lifecycle work as named A4 remainders', () => {
    const ledger = cloneLedger();
    const lane = ledger.coverage.find((entry: any) => entry.id === 'per-session-command-lane');
    expect(lane.productionBinding.deferredPaths.every(
      (path: any) => path.targetMilestone === 'A4',
    )).toBe(true);
    lane.productionBinding.deferredPaths = lane.productionBinding.deferredPaths
      .filter((path: any) => path.id !== 'keyed-route-admission-and-fail-close');

    expect(() => auditSessionRuntimeCoverage({ ledger }))
      .toThrow(/deferredPaths.*keyed-route-admission-and-fail-close/i);
  });
});
