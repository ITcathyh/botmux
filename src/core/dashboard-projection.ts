import { randomUUID } from 'node:crypto';

import type { SessionRow } from './dashboard-rows.js';

export const CURRENT_RUNTIME_CONTRACT = 'Current/v1' as const;

export type CurrentRuntimeStatus =
  | { contract: typeof CURRENT_RUNTIME_CONTRACT; state: 'restoring'; online: true }
  | { contract: typeof CURRENT_RUNTIME_CONTRACT; state: 'ready'; online: true }
  | { contract: typeof CURRENT_RUNTIME_CONTRACT; state: 'stale'; online: false };

export interface DashboardProjectionPosition {
  projectionEpoch: string;
  cursor: number;
}

export interface DashboardSessionSnapshot extends DashboardProjectionPosition {
  readiness: CurrentRuntimeStatus;
  rows: SessionRow[];
}

/**
 * Process-local Current projection protocol. The epoch/cursor describe only
 * this daemon's event stream; they are deliberately not Store schema or
 * durability claims.
 */
export class CurrentDashboardProjectionProtocol {
  private readonly projectionEpoch = randomUUID();
  private cursor = 0;
  private readiness: CurrentRuntimeStatus = {
    contract: CURRENT_RUNTIME_CONTRACT,
    state: 'restoring',
    online: true,
  };

  nextEventPosition(): DashboardProjectionPosition {
    this.cursor += 1;
    return { projectionEpoch: this.projectionEpoch, cursor: this.cursor };
  }

  position(): DashboardProjectionPosition {
    return { projectionEpoch: this.projectionEpoch, cursor: this.cursor };
  }

  status(): CurrentRuntimeStatus {
    return { ...this.readiness };
  }

  markReady(): void {
    this.readiness = { contract: CURRENT_RUNTIME_CONTRACT, state: 'ready', online: true };
  }

  snapshot(rows: SessionRow[]): DashboardSessionSnapshot {
    return {
      ...this.position(),
      readiness: this.status(),
      rows: rows.map(row => ({ ...row })),
    };
  }
}

export const currentDashboardProjectionProtocol = new CurrentDashboardProjectionProtocol();
