import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workerSource = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');

// NB: this file only asserts the WIRING shape of codexBridgeNotifyCliSessionId
// (a module-state-heavy worker-internal function that isn't unit-testable
// end-to-end without spawning a real worker). The behavioral guarantee behind
// the ownership gate — a foreign, shared-CODEX_HOME history sid is NOT in the
// pid's fd set and therefore cannot hijack the binding, while a real
// parent+sibling sid IS — is exercised against real subprocesses in
// codex-coco-pid-discovery.smoke.test.ts (findCodexRolloutSetByPid).
describe('Codex worker structured-bridge wiring', () => {
  it('reattaches an incorrectly discovered rollout after writeInput verifies the session id', () => {
    const start = workerSource.indexOf('function codexBridgeNotifyCliSessionId');
    const end = workerSource.indexOf('// Already attached — first-attach-wins for most CLIs.', start);
    const notify = workerSource.slice(start, end);
    const codexStart = notify.indexOf('if (structuredBridgeIsCodex())');
    const codex = notify.slice(codexStart);

    expect(codexStart).toBeGreaterThanOrEqual(0);
    expect(codex).toContain('codexSessionIdFromRolloutPath(codexBridgeRolloutPath)');
    expect(codex).toContain("resolveFileBridgePath('codex', { sessionId: cliSessionId })");
    expect(codex.indexOf('codexBridgeDetachFile();')).toBeLessThan(codex.indexOf('codexBridgeAttach(next, attachMode);'));
    expect(codex).toContain("lastInitConfig?.adoptMode ? 'split-live' : 'fresh-empty'");
    expect(codex).toContain('codexBridgePendingSessionId = cliSessionId;');
  });

  it('gates the re-attach on pid rollout-fd ownership before detaching (rejects a foreign history sid)', () => {
    const start = workerSource.indexOf('function codexBridgeNotifyCliSessionId');
    const end = workerSource.indexOf('// Already attached — first-attach-wins for most CLIs.', start);
    const codex = workerSource.slice(start, end);

    const gate = codex.indexOf('findCodexRolloutSetByPid(');
    const detach = codex.indexOf('codexBridgeDetachFile();');
    const resolveNext = codex.indexOf("resolveFileBridgePath('codex'");

    // The ownership check must exist AND run before both the path resolution and
    // the detach, so a foreign sid returns early with the binding intact.
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(resolveNext);
    expect(gate).toBeLessThan(detach);
    // Must use the fd-SET accessor, not the ambiguity-collapsing single one
    // (which returns undefined for the parent+sibling case we must ALLOW).
    expect(codex).not.toContain('findCodexRolloutByPid(pid)?.cliSessionId === cliSessionId');
    // Membership test + fail-closed early return when unowned/unknown.
    expect(codex).toContain('.has(cliSessionId.toLowerCase())');
    expect(codex).toContain('refusing history-only re-attach');
  });
});
