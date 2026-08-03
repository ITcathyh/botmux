import { resolveCommand } from './registry.js';
import { BOTMUX_SHELL_HINTS } from './shared-hints.js';
import { preparePiInitialPromptArg } from './pi-initial-prompt.js';
import type { CliAdapter, PtyHandle } from './types.js';

import { delay } from '../../utils/timing.js';

/** Adapter for Pi coding-agent's native TUI (`pi`).
 *
 *  ## Type-ahead (re-enabled 2026-08; first tried b2c2ba67, reverted next day
 *  b7dfa0c0 because Pi then had NO reliable turn boundary — only the screen
 *  marker `Working...`, so merging multiple busy-period inputs mis-attributed
 *  the final reply / crossed Lark cards).
 *
 *  What changed since the revert: PR #327 (2026-06-30) added Pi's per-session
 *  JSONL transcript bridge (`services/pi-transcript.ts`). Pi's `AssistantMessage`
 *  carries an authoritative `stopReason` (`@earendil-works/pi-ai`:
 *  `"stop" | "length" | "toolUse" | "error" | "aborted"`), and `drainPiTranscript`
 *  now emits an `assistant_final` on EVERY terminal stopReason — including empty
 *  error/aborted turns — so CodexBridgeQueue always has a session-scoped
 *  end-of-turn boundary to close (or fail) each turn. That is exactly the
 *  capability whose absence forced the revert.
 *
 *  Pi's Message Queue is an active-turn STEER (verified on 0.80.6 — the TUI
 *  shows "Steering: …" + "Alt+Up to edit all queued messages"): a message
 *  submitted while a turn runs is pulled into that same turn, which emits one
 *  merged final (transcript: user1 → tools → user2 → assistant_final, user2
 *  written at dequeue time). This is the identical shape Codex/Grok produce, and
 *  CodexBridgeQueue's HOL-block-drop + dequeue-time markTimeMs override attribute
 *  the single final to the newest matching Lark turn. We deliberately do NOT set
 *  `mergeQueuedInput`: each Lark message keeps its own botmux turn / card, and
 *  the steer merge is reconciled by the bridge queue rather than by pre-squashing
 *  the queue (which the revert-era code did, collapsing distinct cards).
 *
 *  ## Idle detection
 *  Pi is a pure-quiescence adapter (no `readyPattern`, no `injectsReadyHook`).
 *  `reliableTurnTerminal` only routes idle through `assistant_final → fireIdle`
 *  and suppresses the redundant post-submit "busy-marker absent" probe (which
 *  lagged and could flip card-off DONE early). Quiescence-based idle
 *  (IdleDetector.onIdle) and the reattach idle probe (`scheduleReattachIdleProbe`,
 *  gated on `busyPattern` only — see #b5a41600d) both stay active, so a
 *  reattached persistent pane with no new PTY output is still marked ready via
 *  the `Working...` busy marker. */
export function createPiAdapter(pathOverride?: string): CliAdapter {
  const bin = resolveCommand(pathOverride ?? 'pi');
  return {
    id: 'pi',
    authPaths: ['~/.pi/agent/auth.json'],
    resolvedBin: bin,

    buildArgs({ sessionId, initialPrompt }) {
      const args = [
        '--session-id', sessionId,
      ];
      // Pi's interactive mode processes positional initial messages after TUI
      // startup, avoiding stdin races while keeping the native TUI visible.
      if (initialPrompt) args.push(initialPrompt);
      return args;
    },

    buildResumeCommand({ sessionId }) {
      return `pi --session-id ${sessionId}`;
    },

    prepareInitialPromptArg({ initialPrompt, sessionId, sessionDataDir }) {
      const prepared = preparePiInitialPromptArg({
        prompt: initialPrompt,
        sessionId,
        sessionDataDir,
      });
      return {
        initialPrompt: prepared.initialPromptArg,
        readonlyRoots: prepared.readonlyRoot ? [prepared.readonlyRoot] : undefined,
        cleanupPaths: prepared.filePath ? [prepared.filePath] : undefined,
        cleanupDirs: prepared.cleanupDir ? [prepared.cleanupDir] : undefined,
        deferredInput: prepared.deferredInput,
      };
    },

    passesInitialPromptViaArgs: true,

    async writeInput(pty: PtyHandle, content: string) {
      if (pty.pasteText && pty.sendSpecialKeys) {
        pty.pasteText(content);
        await delay(200);
        pty.sendSpecialKeys('Enter');
      } else {
        pty.write(`\x1b[200~${content}\x1b[201~`);
        await delay(1000);
        pty.write('\r');
      }
    },

    completionPattern: undefined,
    busyPattern: /Working\.\.\./,
    readyPattern: undefined,
    // Pi's native Message Queue parks/steers submit-while-busy input; the JSONL
    // transcript bridge (drainPiTranscript) provides the reliable turn boundary
    // that makes attribution correct. See the header for the full rationale and
    // the b2c2ba67/b7dfa0c0 history. No mergeQueuedInput: one card per Lark turn.
    supportsTypeAhead: true,
    reliableTurnTerminal: true,
    systemHints: BOTMUX_SHELL_HINTS,
    altScreen: true,
    skillsDir: '~/.pi/agent/skills',
  };
}

export const create = createPiAdapter;
