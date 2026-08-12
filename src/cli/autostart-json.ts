import {
  AutostartOperationError,
  setAutostartEnabled,
  type AutostartMutationResult,
  type AutostartOpts,
} from '../autostart.js';

export type AutostartJsonMutationErrorCode =
  | 'command_failed'
  | 'manager_unavailable'
  | 'operation_in_progress'
  | 'state_mismatch'
  | 'target_unavailable'
  | 'unsupported_platform';

export type AutostartJsonMutationEnvelope =
  | ({ ok: true } & AutostartMutationResult)
  | { ok: false; error: AutostartJsonMutationErrorCode; detail: string };

interface AutostartJsonMutationDeps {
  mutate?: (opts: AutostartOpts, enabled: boolean) => AutostartMutationResult;
  writeStdout?: (line: string) => void;
  writeDiagnostic?: (...args: unknown[]) => void;
}

/**
 * Emit exactly one JSON envelope to stdout. Existing platform helpers keep
 * their useful human diagnostics, but all console channels are temporarily
 * redirected to stderr so they cannot corrupt the machine response.
 */
export function writeAutostartJsonMutation(
  opts: AutostartOpts,
  enabled: boolean,
  deps: AutostartJsonMutationDeps = {},
): AutostartJsonMutationEnvelope {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const writeStdout = deps.writeStdout ?? (line => process.stdout.write(`${line}\n`));
  const writeDiagnostic = deps.writeDiagnostic ?? ((...args: unknown[]) => originalError(...args));
  const mutate = deps.mutate ?? setAutostartEnabled;
  let envelope: AutostartJsonMutationEnvelope;

  console.log = (...args: unknown[]) => writeDiagnostic(...args);
  console.warn = (...args: unknown[]) => writeDiagnostic(...args);
  console.error = (...args: unknown[]) => writeDiagnostic(...args);
  try {
    envelope = { ok: true, ...mutate(opts, enabled) };
  } catch (error) {
    const code = error instanceof AutostartOperationError
      ? error.code === 'mutation_failed' ? 'command_failed' : error.code
      : 'command_failed';
    envelope = {
      ok: false,
      error: code,
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }

  writeStdout(JSON.stringify(envelope));
  return envelope;
}
