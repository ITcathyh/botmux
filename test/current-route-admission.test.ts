import { describe, expect, it, vi } from 'vitest';

import {
  currentRouteAdmissionKey,
  reserveCurrentRouteAdmission,
} from '../src/core/current-route-admission.js';

describe('Current route admission', () => {
  it('serializes ordinary/manual/deadline producers sharing one owner route', async () => {
    const key = currentRouteAdmissionKey({
      ownerLarkAppId: 'cli_owner',
      scope: 'chat',
      canonicalAnchor: 'oc_chat',
      chatId: 'oc_chat',
      chatType: 'group',
    });
    const first = reserveCurrentRouteAdmission(key);
    const second = reserveCurrentRouteAdmission(key);
    const admitted = vi.fn();
    void second.ready.then(admitted);

    await first.ready;
    await Promise.resolve();
    expect(admitted).not.toHaveBeenCalled();
    first.release();
    await second.ready;
    expect(admitted).toHaveBeenCalledTimes(1);
    second.release();
  });

  it('does not couple the same route across different Bot owners', async () => {
    const base = {
      scope: 'thread' as const,
      canonicalAnchor: 'om_root',
      chatId: 'oc_chat',
      chatType: 'group' as const,
    };
    const first = reserveCurrentRouteAdmission(currentRouteAdmissionKey({
      ...base, ownerLarkAppId: 'cli_owner_a',
    }));
    const otherOwner = reserveCurrentRouteAdmission(currentRouteAdmissionKey({
      ...base, ownerLarkAppId: 'cli_owner_b',
    }));

    await expect(otherOwner.ready).resolves.toBeUndefined();
    first.release();
    otherOwner.release();
  });
});
