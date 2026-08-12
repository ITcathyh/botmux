/**
 * Owner/route-scoped admission shared by every Current route command producer.
 * It serializes only route resolution/publication; resolved Session commands
 * continue through the SessionRuntime FIFO lane.
 */

interface RouteAdmissionQueue {
  tail: Promise<void>;
  depth: number;
}

/** Exact route identity guarded by this shared admission authority. */
export interface CurrentRouteAdmissionRoute {
  readonly scope: 'thread' | 'chat';
  readonly canonicalAnchor: string;
  readonly chatId: string;
  readonly chatType: 'group' | 'p2p';
}

const admissions = new Map<string, RouteAdmissionQueue>();
const routeAdmissionTokens = new WeakMap<object, {
  readonly key: string;
  current: boolean;
}>();

/** Validate an opaque capability minted for the exact admission key. A token
 * is authoritative only after its predecessor has released and before its own
 * release; queued or released tokens carry no route-mutation authority. */
export function isCurrentRouteAdmissionToken(input: {
  readonly token: unknown;
  readonly key: string;
}): boolean {
  if (!input.token || typeof input.token !== 'object') return false;
  const held = routeAdmissionTokens.get(input.token);
  return held?.current === true && held.key === input.key;
}

export function currentRouteAdmissionKey(input: {
  readonly ownerLarkAppId: string;
} & CurrentRouteAdmissionRoute): string {
  return `${input.ownerLarkAppId}\u0000${input.scope}\u0000${input.canonicalAnchor}`
    + `\u0000${input.chatId}\u0000${input.chatType}`;
}

export function reserveCurrentRouteAdmission(key: string): {
  readonly ready: Promise<void>;
  readonly token: object;
  release(): void;
} {
  let queue = admissions.get(key);
  if (!queue) {
    queue = { tail: Promise.resolve(), depth: 0 };
    admissions.set(key, queue);
  }
  const predecessor = queue.tail;
  let releaseTail!: () => void;
  const tail = new Promise<void>((resolve) => { releaseTail = resolve; });
  queue.tail = tail;
  queue.depth += 1;
  const token = Object.freeze(Object.create(null)) as object;
  const held = { key, current: false };
  routeAdmissionTokens.set(token, held);
  let releaseRequested = false;
  let finalized = false;
  const finalizeRelease = (): void => {
    if (finalized) return;
    finalized = true;
    held.current = false;
    routeAdmissionTokens.delete(token);
    releaseTail();
    queue!.depth -= 1;
    if (queue!.depth === 0 && queue!.tail === tail) admissions.delete(key);
  };
  const ready = predecessor.then(() => {
    if (finalized) return;
    held.current = true;
    if (releaseRequested) finalizeRelease();
  });
  return {
    ready,
    token,
    release() {
      if (releaseRequested || finalized) return;
      releaseRequested = true;
      if (held.current) finalizeRelease();
    },
  };
}
