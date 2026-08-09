import type { VcMeetingImTurnOrigin } from '../types.js';

const MAX_VC_MEETING_IM_TURN_ORIGINS = 256;

export interface VcMeetingImTurnOriginSession {
  sessionId: string;
  vcMeetingImTurnOrigins?: Record<string, VcMeetingImTurnOrigin>;
}

export function rememberVcMeetingImTurnOrigin(
  session: VcMeetingImTurnOriginSession,
  origin: VcMeetingImTurnOrigin,
): void {
  if (origin.receiverSessionId !== session.sessionId || !origin.larkMessageId) return;
  const origins = session.vcMeetingImTurnOrigins ??= {};
  // Refresh exact redeliveries in insertion order so pruning retains the most
  // recently observed authority. 256 entries comfortably exceeds the normal
  // worker queue while a pathological flood still fails old turns closed
  // instead of growing state without bound.
  delete origins[origin.larkMessageId];
  origins[origin.larkMessageId] = structuredClone(origin);
  const keys = Object.keys(origins);
  for (let index = 0; index < keys.length - MAX_VC_MEETING_IM_TURN_ORIGINS; index += 1) {
    delete origins[keys[index]!];
  }
}
