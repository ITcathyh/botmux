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
      ordinaryFakeAdapterSource: 'src/core/current-ordinary-ingress.ts',
      ordinaryFakeAdapterFactory: 'createCurrentOrdinaryIngressPort',
      ordinaryProductionWired: false,
      ordinaryUnwiredProductionProof: {
        sourceFile: 'src/daemon.ts',
        forbiddenImports: [
          './core/current-session-runtime.js',
          './core/current-ordinary-ingress.js',
        ],
        forbiddenCalls: [
          'currentSessionRuntimeHost',
          'createCurrentOrdinaryIngressPort',
        ],
        forbiddenOption: 'ordinaryIngress',
      },
    });
    expect(ordinary).toMatchObject({
      targetMilestone: 'C1',
      disposition: 'remaining',
    });
    expect(ordinary.productionBinding).toBeUndefined();
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

  it('rejects claiming the fake ordinary Current port as production-wired', () => {
    const ledger = cloneLedger();
    const lane = ledger.coverage.find((entry: any) => entry.id === 'per-session-command-lane');
    lane.productionBinding.ordinaryProductionWired = true;

    expect(() => auditSessionRuntimeCoverage({ ledger }))
      .toThrow(/ordinaryProductionWired.*false|ordinary.*must remain unwired/i);
  });

  it.each([
    {
      label: 'production source',
      remove: (proof: Record<string, any>) => { delete proof.sourceFile; },
    },
    {
      label: 'forbidden production imports',
      remove: (proof: Record<string, any>) => {
        proof.forbiddenImports = (proof.forbiddenImports ?? []).slice(0, -1);
      },
    },
    {
      label: 'forbidden production factories',
      remove: (proof: Record<string, any>) => {
        proof.forbiddenCalls = (proof.forbiddenCalls ?? []).slice(0, -1);
      },
    },
    {
      label: 'forbidden ordinary port injection',
      remove: (proof: Record<string, any>) => { delete proof.forbiddenOption; },
    },
  ])('rejects deleting the false ordinary-wiring proof for $label', ({ remove }) => {
    const ledger = cloneLedger();
    const lane = ledger.coverage.find((entry: any) => entry.id === 'per-session-command-lane');
    const proof = lane.productionBinding.ordinaryUnwiredProductionProof ?? {};
    remove(proof);
    lane.productionBinding.ordinaryUnwiredProductionProof = proof;

    expect(() => auditSessionRuntimeCoverage({ ledger }))
      .toThrow(/ordinaryUnwiredProductionProof|ordinary production.*unwired/i);
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

  it('keeps keyed route fail-close and long lifecycle work as named remainders', () => {
    const ledger = cloneLedger();
    const lane = ledger.coverage.find((entry: any) => entry.id === 'per-session-command-lane');
    lane.productionBinding.deferredPaths = lane.productionBinding.deferredPaths
      .filter((path: any) => path.id !== 'keyed-route-admission-and-fail-close');

    expect(() => auditSessionRuntimeCoverage({ ledger }))
      .toThrow(/deferredPaths.*keyed-route-admission-and-fail-close/i);
  });
});
