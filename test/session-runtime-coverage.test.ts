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
});
