import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  collectRawSessionFileWriters,
  collectSessionStateInventory,
  createSessionStateAuditProgram,
  mergeReviewedMutationSites,
} from '../scripts/audit-session-state-inventory.mjs';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, '..');
const auditScript = resolve(repoRoot, 'scripts/audit-session-state-inventory.mjs');
const fixturePath = 'test/fixtures/session-state-audit/semantics.ts';

describe('Session authority inventory', () => {
  it('matches the semantic mutation census and named Current authorities', () => {
    const result = spawnSync(process.execPath, [auditScript], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('[session-state-audit] verified:');
  });

  it('recognizes direct and aliased writes without treating derived copies as writes', () => {
    const program = createSessionStateAuditProgram([fixturePath]);
    const sites = collectSessionStateInventory({
      program,
      includeSourcePaths: [fixturePath],
    });

    expect(sites.map(site => ({
      enclosingFunction: site.enclosingFunction,
      receiverKind: site.receiverKind,
      fieldPath: site.fieldPath,
      operation: site.operation,
      authorityId: site.authorityId,
    }))).toEqual([
      {
        enclosingFunction: 'directAndAliasedMutations',
        receiverKind: 'DaemonSessionMap',
        fieldPath: '*',
        operation: 'mutate:delete',
        authorityId: 'active-session-registry',
      },
      {
        enclosingFunction: 'directAndAliasedMutations',
        receiverKind: 'DaemonSessionMap',
        fieldPath: '*',
        operation: 'mutate:set',
        authorityId: 'active-session-registry',
      },
      {
        enclosingFunction: 'directAndAliasedMutations',
        receiverKind: 'Session',
        fieldPath: '*',
        operation: 'assign',
        authorityId: 'current-session-row',
      },
      {
        enclosingFunction: 'directAndAliasedMutations',
        receiverKind: 'Session',
        fieldPath: 'codexAppDispatchLedger',
        operation: 'assign',
        authorityId: 'codex-app-dispatch-control',
      },
      {
        enclosingFunction: 'directAndAliasedMutations',
        receiverKind: 'Session',
        fieldPath: 'codexAppDispatchLedger',
        operation: 'assign',
        authorityId: 'codex-app-dispatch-control',
      },
      {
        enclosingFunction: 'directAndAliasedMutations',
        receiverKind: 'Session',
        fieldPath: 'docCommentTargets',
        operation: 'delete',
        authorityId: 'doc-comment-turn-target',
      },
      {
        enclosingFunction: 'directAndAliasedMutations',
        receiverKind: 'Session',
        fieldPath: 'forkChildSessionIds',
        operation: 'mutate:push',
        authorityId: 'current-session-row',
      },
      {
        enclosingFunction: 'directAndAliasedMutations',
        receiverKind: 'Session',
        fieldPath: 'pendingRepoSetup',
        operation: 'assign',
        authorityId: 'pending-repo-and-activation',
      },
      {
        enclosingFunction: 'directAndAliasedMutations',
        receiverKind: 'Session',
        fieldPath: 'pendingRepoSetup',
        operation: 'assign',
        authorityId: 'pending-repo-and-activation',
      },
      {
        enclosingFunction: 'directAndAliasedMutations',
        receiverKind: 'Session',
        fieldPath: 'queuedActivationTail',
        operation: 'compound_assign',
        authorityId: 'pending-repo-and-activation',
      },
      {
        enclosingFunction: 'directAndAliasedMutations',
        receiverKind: 'Session',
        fieldPath: 'riffRepoDirs',
        operation: 'mutate:push',
        authorityId: 'riff-lineage',
      },
      {
        enclosingFunction: 'directAndAliasedMutations',
        receiverKind: 'Session',
        fieldPath: 'status',
        operation: 'assign',
        authorityId: 'current-session-row',
      },
      {
        enclosingFunction: 'directAndAliasedMutations',
        receiverKind: 'Session',
        fieldPath: 'title',
        operation: 'object_assign',
        authorityId: 'current-session-row',
      },
      {
        enclosingFunction: 'directAndAliasedMutations',
        receiverKind: 'Session',
        fieldPath: 'vcMeetingImTurnOrigins',
        operation: 'assign',
        authorityId: 'vc-action-and-delivery',
      },
      {
        enclosingFunction: 'directAndAliasedMutations',
        receiverKind: 'Session',
        fieldPath: 'vcMeetingImTurnOrigins',
        operation: 'compound_assign',
        authorityId: 'vc-action-and-delivery',
      },
    ]);
    expect(sites.every(site => /^[a-f0-9]{16}$/.test(site.normalizedAstHash))).toBe(true);
    expect(sites.some(site => site.enclosingFunction === 'derivedCopiesAreNotMutations')).toBe(false);
  });

  it('keeps the narrow VC turn-origin Adapter inside the Session authority census', () => {
    const sourcePath = 'src/core/vc-meeting-im-turn-origin.ts';
    const sites = collectSessionStateInventory({
      includeSourcePaths: [sourcePath],
    });

    expect(sites.map(site => ({
      sourceFile: site.sourceFile,
      enclosingFunction: site.enclosingFunction,
      receiverKind: site.receiverKind,
      fieldPath: site.fieldPath,
      operation: site.operation,
      classification: site.classification,
      authorityId: site.authorityId,
      accessLane: site.accessLane,
    }))).toEqual([
      {
        sourceFile: sourcePath,
        enclosingFunction: 'rememberVcMeetingImTurnOrigin',
        receiverKind: 'Session',
        fieldPath: 'vcMeetingImTurnOrigins',
        operation: 'assign',
        classification: 'path_specific_authority',
        authorityId: 'vc-action-and-delivery',
        accessLane: 'current-vc-meeting-im-turn-origin-adapter',
      },
      {
        sourceFile: sourcePath,
        enclosingFunction: 'rememberVcMeetingImTurnOrigin',
        receiverKind: 'Session',
        fieldPath: 'vcMeetingImTurnOrigins',
        operation: 'compound_assign',
        classification: 'path_specific_authority',
        authorityId: 'vc-action-and-delivery',
        accessLane: 'current-vc-meeting-im-turn-origin-adapter',
      },
      {
        sourceFile: sourcePath,
        enclosingFunction: 'rememberVcMeetingImTurnOrigin',
        receiverKind: 'Session',
        fieldPath: 'vcMeetingImTurnOrigins',
        operation: 'delete',
        classification: 'path_specific_authority',
        authorityId: 'vc-action-and-delivery',
        accessLane: 'current-vc-meeting-im-turn-origin-adapter',
      },
      {
        sourceFile: sourcePath,
        enclosingFunction: 'rememberVcMeetingImTurnOrigin',
        receiverKind: 'Session',
        fieldPath: 'vcMeetingImTurnOrigins',
        operation: 'delete',
        classification: 'path_specific_authority',
        authorityId: 'vc-action-and-delivery',
        accessLane: 'current-vc-meeting-im-turn-origin-adapter',
      },
    ]);
  });

  it('discovers raw Session file publishers instead of trusting a manual symbol list', () => {
    const program = createSessionStateAuditProgram([fixturePath]);
    const writers = collectRawSessionFileWriters({
      program,
      includeSourcePaths: [fixturePath],
    });
    expect(writers.map(({ sourceFile, enclosingFunction }) => ({ sourceFile, enclosingFunction }))).toEqual([
      {
        sourceFile: fixturePath,
        enclosingFunction: 'helperBuiltAliasedRawSessionWriter',
      },
      {
        sourceFile: fixturePath,
        enclosingFunction: 'syntheticRawSessionWriter',
      },
    ]);
    expect(writers.every(writer => (
      writer.siteCount === 1
      && /^[a-f0-9]{16}$/.test(writer.siteDigest)
      && /^[a-f0-9]{16}$/.test(writer.functionDigest)
    ))).toBe(true);
  });

  it('never guesses ownership for a newly discovered mutation site', () => {
    const site = {
      sourceFile: fixturePath,
      enclosingFunction: 'newMutation',
      receiverKind: 'Session',
      fieldPath: 'status',
      operation: 'assign',
      normalizedAstHash: '0123456789abcdef',
      count: 1,
      classification: 'session_owned_persisted',
      authorityId: 'current-session-row',
      accessLane: 'direct-caller-mutation',
    };
    expect(mergeReviewedMutationSites([site], [])).toEqual([{
      ...site,
      classification: 'UNCLASSIFIED',
      authorityId: 'UNCLASSIFIED',
      accessLane: 'UNCLASSIFIED',
    }]);
    expect(mergeReviewedMutationSites([site], [site])).toEqual([site]);
  });
});
