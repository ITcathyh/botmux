import { basename } from 'node:path';

import type { CliId } from '../adapters/cli/types.js';
import {
  sameRuntimeIdentity,
  type CliRuntimeConfig,
  type CliRuntimeSnapshot,
} from '../adapters/cli/runtime.js';
import type { Session } from '../types.js';

export interface SessionCliSelectionTarget {
  readonly cliId: CliId;
  readonly wrapperCli?: string;
  readonly cliRuntime?: CliRuntimeConfig;
  readonly cliPathOverride?: string;
}

export interface SessionCliSelectionMismatch {
  readonly sessionCli: string;
  readonly targetCli: string;
}

function describeCli(
  cliId: CliId,
  runtime: CliRuntimeConfig | CliRuntimeSnapshot | undefined,
  legacyPath: string | undefined,
  wrapper: string | undefined,
): string {
  const runtimeName = runtime?.displayName ?? runtime?.id ?? (legacyPath ? basename(legacyPath) : cliId);
  return wrapper ? `${wrapper} (${runtimeName})` : runtimeName;
}

/** Compare one frozen Session launch identity with an explicit desired target. */
export function sessionCliSelectionMismatch(
  session: Pick<Session,
    | 'agentFrozen'
    | 'cliId'
    | 'cliPathOverride'
    | 'cliRuntime'
    | 'wrapperCli'>,
  target: SessionCliSelectionTarget,
): SessionCliSelectionMismatch | null {
  const sessionCliId = session.cliId;
  if (!sessionCliId) return null;
  const sessionWrapper = session.wrapperCli?.trim() || undefined;
  const targetWrapper = target.wrapperCli?.trim() || undefined;
  const mismatch = sessionCliId !== target.cliId
    || (session.agentFrozen === true && !sameRuntimeIdentity(
      {
        cliId: sessionCliId,
        cliRuntime: session.cliRuntime,
        cliPathOverride: session.cliPathOverride,
        wrapperCli: sessionWrapper,
      },
      {
        cliId: target.cliId,
        cliRuntime: target.cliRuntime,
        cliPathOverride: target.cliPathOverride,
        wrapperCli: targetWrapper,
      },
    ));
  if (!mismatch) return null;
  return {
    sessionCli: describeCli(
      sessionCliId,
      session.cliRuntime,
      session.cliPathOverride,
      sessionWrapper,
    ),
    targetCli: describeCli(
      target.cliId,
      target.cliRuntime,
      target.cliPathOverride,
      targetWrapper,
    ),
  };
}
