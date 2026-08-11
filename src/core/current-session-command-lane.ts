import { createSessionCommandLaneHost } from './session-command-lane.js';
import type { BotId } from './bot-identity.js';

/** One process-local lane directory shared by Current Runtime modules. */
const currentHost = createSessionCommandLaneHost();

export const currentSessionCommandLane = currentHost.lane;

export function currentSessionLaneAddressForKey(
  runtimeEpoch: string,
  ownerScopedSessionKey: string,
) {
  return currentHost.addressFor(
    `${runtimeEpoch}\0${ownerScopedSessionKey}`,
  );
}

export function currentSessionLaneAddress(
  runtimeEpoch: string,
  ownerBotId: BotId,
  sessionId: string,
) {
  return currentSessionLaneAddressForKey(
    runtimeEpoch,
    `${ownerBotId}\0${sessionId}`,
  );
}
