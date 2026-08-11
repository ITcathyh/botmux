/**
 * Owner/route-scoped admission shared by every Current route command producer.
 * It serializes only route resolution/publication; resolved Session commands
 * continue through the SessionRuntime FIFO lane.
 */

interface RouteAdmissionQueue {
  tail: Promise<void>;
  depth: number;
}

const admissions = new Map<string, RouteAdmissionQueue>();

export function currentRouteAdmissionKey(input: {
  readonly ownerLarkAppId: string;
  readonly scope: 'thread' | 'chat';
  readonly canonicalAnchor: string;
  readonly chatId: string;
  readonly chatType: 'group' | 'p2p';
}): string {
  return `${input.ownerLarkAppId}\u0000${input.scope}\u0000${input.canonicalAnchor}`
    + `\u0000${input.chatId}\u0000${input.chatType}`;
}

export function reserveCurrentRouteAdmission(key: string): {
  readonly ready: Promise<void>;
  release(): void;
} {
  let queue = admissions.get(key);
  if (!queue) {
    queue = { tail: Promise.resolve(), depth: 0 };
    admissions.set(key, queue);
  }
  const ready = queue.tail;
  let releaseTail!: () => void;
  const tail = new Promise<void>((resolve) => { releaseTail = resolve; });
  queue.tail = tail;
  queue.depth += 1;
  let released = false;
  return {
    ready,
    release() {
      if (released) return;
      released = true;
      releaseTail();
      queue!.depth -= 1;
      if (queue!.depth === 0 && queue!.tail === tail) admissions.delete(key);
    },
  };
}
