/**
 * Process-local FIFO lane for short Session state transitions.
 *
 * A reducer must finish synchronously and may only return state/outcome/effect
 * intents. Agent CLI, Lark, backend, and other awaited work runs after the
 * reducer returns and reports completion through another lane submission.
 */

declare const sessionLaneAddressBrand: unique symbol;

/** Opaque identity minted by the owner-bound composition layer. */
export type SessionLaneAddress = Readonly<Record<never, never>> & {
  readonly [sessionLaneAddressBrand]: true;
};

interface LaneJob<T> {
  reduce: () => T;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

interface LaneCell {
  draining: boolean;
  queue: LaneJob<unknown>[];
}

export interface SessionCommandLane {
  /**
   * The idle reducer starts in the caller's current run-to-completion segment.
   * Re-entrant reducers for the same address queue and drain iteratively.
   */
  submit<T>(address: SessionLaneAddress, reduce: () => T): Promise<T>;
}

export interface SessionCommandLaneHost {
  lane: SessionCommandLane;
  /** Internal composition seam; callers never receive the stable lookup key. */
  addressFor(logicalSessionKey: string): SessionLaneAddress;
}

function assertShortTransition<T>(value: T): T {
  if (value !== null
    && (typeof value === 'object' || typeof value === 'function')
    && typeof (value as { then?: unknown }).then === 'function') {
    // Consume a rejected thenable so an invalid Adapter cannot add an
    // unhandled-rejection side channel after the lane fails closed.
    void Promise.resolve(value).catch(() => undefined);
    throw new Error('Session command lane reducer must be synchronous');
  }
  return value;
}

export function createSessionCommandLaneHost(): SessionCommandLaneHost {
  const addresses = new Map<string, SessionLaneAddress>();
  const cells = new Map<SessionLaneAddress, LaneCell>();

  const addressFor = (logicalSessionKey: string): SessionLaneAddress => {
    if (!logicalSessionKey) throw new Error('Session lane identity must not be empty');
    const existing = addresses.get(logicalSessionKey);
    if (existing) return existing;
    const address = Object.freeze({}) as SessionLaneAddress;
    addresses.set(logicalSessionKey, address);
    return address;
  };

  const cellFor = (address: SessionLaneAddress): LaneCell => {
    let cell = cells.get(address);
    if (!cell) {
      cell = { draining: false, queue: [] };
      cells.set(address, cell);
    }
    return cell;
  };

  const drain = (address: SessionLaneAddress, cell: LaneCell): void => {
    if (cell.draining) return;
    cell.draining = true;
    try {
      while (cell.queue.length > 0) {
        const job = cell.queue.shift()!;
        try {
          job.resolve(assertShortTransition(job.reduce()));
        } catch (error) {
          job.reject(error);
        }
      }
    } finally {
      cell.draining = false;
      if (cell.queue.length === 0 && cells.get(address) === cell) {
        cells.delete(address);
      }
    }
  };

  return {
    addressFor,
    lane: {
      submit(address, reduce) {
        const cell = cellFor(address);
        const pending = new Promise<ReturnType<typeof reduce>>((resolve, reject) => {
          cell.queue.push({
            reduce,
            resolve: resolve as (value: unknown) => void,
            reject,
          });
        });
        drain(address, cell);
        return pending;
      },
    },
  };
}
