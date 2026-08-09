import { describe, expect, it } from 'vitest';

import {
  rememberVcMeetingImTurnOrigin,
  type VcMeetingImTurnOriginSession,
} from '../src/core/vc-meeting-im-turn-origin.js';
import type { VcMeetingImTurnOrigin } from '../src/types.js';

function origin(
  receiverSessionId = 'receiver-session',
  larkMessageId = 'om_exact',
): VcMeetingImTurnOrigin {
  return {
    listenerAppId: 'listener-app',
    meetingId: 'meeting',
    memberId: 'member',
    memberEpoch: 1,
    agentAppId: 'agent-app',
    ownerBootId: 'owner-boot',
    ownerEpoch: 2,
    membershipGeneration: 3,
    sinkOwnerGeneration: 4,
    receiverSessionId,
    larkMessageId,
    replyTargetSenderOpenId: 'ou_sender',
  };
}

describe('rememberVcMeetingImTurnOrigin', () => {
  it('records authority under the exact message key for the exact receiver', () => {
    const session = { sessionId: 'receiver-session' };
    const accepted = origin();

    rememberVcMeetingImTurnOrigin(session, accepted);

    expect(session).toEqual({
      sessionId: 'receiver-session',
      vcMeetingImTurnOrigins: {
        om_exact: accepted,
      },
    });
  });

  it.each([
    ['a different receiver', origin('other-session')],
    ['a blank message key', origin('receiver-session', '')],
  ])('does not mutate the session for %s', (_label, rejected) => {
    const session = { sessionId: 'receiver-session' };
    const before = structuredClone(session);

    rememberVcMeetingImTurnOrigin(session, rejected);

    expect(session).toEqual(before);
  });

  it('stores a detached authority snapshot', () => {
    const session: VcMeetingImTurnOriginSession = { sessionId: 'receiver-session' };
    const accepted = origin('receiver-session', 'om_detached');

    rememberVcMeetingImTurnOrigin(session, accepted);
    const stored = session.vcMeetingImTurnOrigins?.om_detached;
    accepted.ownerEpoch = 99;
    accepted.replyTargetSenderOpenId = 'ou_changed';

    expect(stored).not.toBe(accepted);
    expect(stored).toMatchObject({
      ownerEpoch: 2,
      replyTargetSenderOpenId: 'ou_sender',
    });
  });

  it('keeps the newest 256 authorities and refreshes a redelivery in pruning order', () => {
    const session: VcMeetingImTurnOriginSession = { sessionId: 'receiver-session' };
    const messageKey = (index: number) => `om_${String(index).padStart(3, '0')}`;
    for (let index = 0; index < 256; index += 1) {
      rememberVcMeetingImTurnOrigin(session, origin('receiver-session', messageKey(index)));
    }

    const redelivery = origin('receiver-session', messageKey(0));
    redelivery.ownerEpoch = 20;
    rememberVcMeetingImTurnOrigin(session, redelivery);
    rememberVcMeetingImTurnOrigin(session, origin('receiver-session', messageKey(256)));

    const origins = session.vcMeetingImTurnOrigins!;
    expect(Object.keys(origins)).toHaveLength(256);
    expect(origins[messageKey(1)]).toBeUndefined();
    expect(origins[messageKey(0)]?.ownerEpoch).toBe(20);
    expect(Object.keys(origins).slice(-2)).toEqual([messageKey(0), messageKey(256)]);
  });
});
