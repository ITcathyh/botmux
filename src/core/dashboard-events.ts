// src/core/dashboard-events.ts
import { logger } from '../utils/logger.js';
import {
  currentDashboardProjectionProtocol,
  type CurrentDashboardProjectionProtocol,
  type DashboardProjectionPosition,
} from './dashboard-projection.js';

/** Event union — every payload is JSON-serialisable. */
export type DashboardEventInput =
  | { type: 'session.spawned';   body: { session: any /* SessionRow */ } }
  | { type: 'session.update';    body: { sessionId: string; patch: Record<string, any> } }
  | { type: 'session.exited';    body: { sessionId: string; reason?: string } }
  | { type: 'schedule.created';  body: { schedule: any /* ScheduleRow */ } }
  | { type: 'schedule.updated';  body: { id: string; patch: Record<string, any> } }
  | { type: 'schedule.deleted';  body: { id: string } }
  | { type: 'schedule.fired';    body: { id: string; runAt: number; status: 'ok'|'error'; error?: string } }
  | { type: 'schedule.timezone'; body: { timezone: string } }
  | { type: 'projection.rebuilt'; body: Record<string, never> }
  | { type: 'bots.changed';      body: { signature: string } }
  | { type: 'heartbeat';         body: { ts: number } };

type DashboardSessionEventInput = Extract<DashboardEventInput, { type: `session.${string}` }>;
type DashboardNonSessionEvent = Exclude<DashboardEventInput, { type: `session.${string}` }>;

export type DashboardSessionEvent = DashboardSessionEventInput & {
  projectionEpoch: string;
  sequence: number;
};

export type DashboardEvent = DashboardSessionEvent | DashboardNonSessionEvent;

export type Subscriber = (event: DashboardEvent) => void;

export class DashboardEventBus {
  private subs = new Set<Subscriber>();

  constructor(
    private readonly protocol: CurrentDashboardProjectionProtocol = currentDashboardProjectionProtocol,
  ) {}

  subscribe(fn: Subscriber): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  position(): DashboardProjectionPosition {
    return this.protocol.position();
  }

  publish(event: DashboardEventInput): void {
    const delivered: DashboardEvent = event.type.startsWith('session.')
      ? {
          ...event,
          ...(() => {
            const position = this.protocol.nextEventPosition();
            return {
              projectionEpoch: position.projectionEpoch,
              sequence: position.cursor,
            };
          })(),
        } as DashboardSessionEvent
      : event as DashboardNonSessionEvent;
    for (const fn of this.subs) {
      try { fn(delivered); } catch (err) {
        // Subscriber errors must not break publishing.
        logger.error(`[dashboard-events] subscriber threw: ${err}`);
      }
    }
  }
}

/** Process-wide singleton — daemon publishers and IPC SSE handler share. */
export const dashboardEventBus = new DashboardEventBus();
