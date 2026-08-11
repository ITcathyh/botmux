// src/dashboard/aggregator.ts
import type { DaemonInfo } from './registry.js';
import type { DashboardEvent, DashboardEventInput } from '../core/dashboard-events.js';
import {
  CURRENT_RUNTIME_CONTRACT,
  type CurrentRuntimeStatus,
  type DashboardSessionSnapshot,
} from '../core/dashboard-projection.js';

type Row = { sessionId: string; larkAppId: string; [k: string]: unknown };
type Sched = { id: string; [k: string]: unknown };
const SESSION_PRESENTATION_FIELDS = ['botAvatarUrl', 'repoName', 'gitBranch'] as const;

function mergeSpawnedRow(current: Row | undefined, incoming: Row, larkAppId: string): Row {
  const next: Row = { ...incoming, larkAppId };
  if (current && current.workingDir === next.workingDir) {
    for (const field of SESSION_PRESENTATION_FIELDS) {
      if (next[field] === undefined && current[field] !== undefined) {
        next[field] = current[field];
      }
    }
  }
  return next;
}

/**
 * Aggregates session and schedule state across all online daemons.
 * Pure state machine — no I/O. The dashboard process feeds it events from
 * each daemon's SSE stream (via subscribeDaemon below) and from initial
 * hydration calls (via GET /api/sessions /api/schedules).
 */
export class Aggregator {
  private sessions = new Map<string, Row>();
  private schedules = new Map<string, Sched>();
  private projections = new Map<string, {
    projectionEpoch: string;
    cursor: number;
    readiness: CurrentRuntimeStatus;
  }>();
  private listeners = new Set<(e: DashboardEvent & { larkAppId: string }) => void>();

  private sessionKey(larkAppId: string, sessionId: string): string {
    return `${larkAppId}\u0000${sessionId}`;
  }

  private sessionsMatching(sessionId: string): Row[] {
    return [...this.sessions.values()].filter(row => row.sessionId === sessionId);
  }

  applyEvent(
    larkAppId: string,
    ev: DashboardEvent | DashboardEventInput,
  ): 'applied' | 'ignored' | 'rebuildRequired' {
    if (ev.type.startsWith('session.')
        && 'projectionEpoch' in ev
        && 'sequence' in ev) {
      const current = this.projections.get(larkAppId);
      if (!current || ev.projectionEpoch !== current.projectionEpoch) {
        return 'rebuildRequired';
      }
      if (ev.sequence <= current.cursor) return 'ignored';
      if (ev.sequence !== current.cursor + 1) return 'rebuildRequired';
      current.cursor = ev.sequence;
    }
    let emitted = ev;
    switch (ev.type) {
      case 'session.spawned': {
        const r = ev.body.session as Row;
        const key = this.sessionKey(larkAppId, r.sessionId);
        const next = mergeSpawnedRow(this.sessions.get(key), r, larkAppId);
        this.sessions.set(key, next);
        emitted = { ...ev, body: { session: next } };
        break;
      }
      case 'session.update': {
        const key = this.sessionKey(larkAppId, ev.body.sessionId);
        const cur = this.sessions.get(key);
        if (cur) {
          const patch = { ...ev.body.patch };
          if (
            Object.prototype.hasOwnProperty.call(patch, 'workingDir')
            && patch.workingDir !== cur.workingDir
          ) {
            patch.repoName = null;
            patch.gitBranch = null;
          }
          this.sessions.set(key, { ...cur, ...patch });
          emitted = { ...ev, body: { ...ev.body, patch } };
        }
        break;
      }
      case 'session.exited': {
        const key = this.sessionKey(larkAppId, ev.body.sessionId);
        const cur = this.sessions.get(key);
        // Executor loss is not a Session lifecycle close. A later authoritative
        // row/update may truthfully publish `closed` after persistence commits.
        if (cur && cur.status !== 'closed') {
          this.sessions.set(key, { ...cur, status: 'dormant' });
          emitted = {
            ...ev,
            type: 'session.update',
            body: { sessionId: ev.body.sessionId, patch: { status: 'dormant' } },
          };
        }
        break;
      }
      case 'schedule.created':
        this.schedules.set((ev.body.schedule as Sched).id, ev.body.schedule as Sched);
        break;
      case 'schedule.updated': {
        const cur = this.schedules.get(ev.body.id);
        if (cur) this.schedules.set(ev.body.id, { ...cur, ...ev.body.patch });
        break;
      }
      case 'schedule.deleted':
        this.schedules.delete(ev.body.id);
        break;
      // schedule.fired and heartbeat are pass-through (no cache mutation)
    }
    for (const fn of this.listeners) {
      try { fn({ ...emitted, larkAppId } as any); } catch { /* swallow */ }
    }
    return 'applied';
  }

  /** Legacy additive seed used by schedule/presentation tests. */
  hydrateSessions(larkAppId: string, rows: Row[]): void {
    for (const r of rows) {
      const key = this.sessionKey(larkAppId, r.sessionId);
      this.sessions.set(key, mergeSpawnedRow(this.sessions.get(key), r, larkAppId));
    }
  }

  /** Authoritative replacement of exactly one daemon owner's Session slice. */
  replaceSessionSnapshot(larkAppId: string, snapshot: DashboardSessionSnapshot): void {
    const incoming = new Set<string>();
    for (const rawRow of snapshot.rows) {
      const row = rawRow as unknown as Row;
      const key = this.sessionKey(larkAppId, row.sessionId);
      incoming.add(key);
      this.sessions.set(key, mergeSpawnedRow(this.sessions.get(key), row, larkAppId));
    }
    for (const [key, row] of this.sessions) {
      if (row.larkAppId === larkAppId && !incoming.has(key)) this.sessions.delete(key);
    }
    this.projections.set(larkAppId, {
      projectionEpoch: snapshot.projectionEpoch,
      cursor: snapshot.cursor,
      readiness: { ...snapshot.readiness },
    });
    // Downstream browser caches are another disposable projection. Signal the
    // authoritative replacement so an already-open Dashboard stream re-reads
    // its aggregate snapshot instead of retaining rows from before the gap.
    for (const fn of this.listeners) {
      try {
        fn({ type: 'projection.rebuilt', body: {}, larkAppId });
      } catch { /* swallow */ }
    }
  }

  markRuntimeStale(larkAppId: string): void {
    const current = this.projections.get(larkAppId);
    this.projections.set(larkAppId, {
      projectionEpoch: current?.projectionEpoch ?? '',
      cursor: current?.cursor ?? 0,
      readiness: { contract: CURRENT_RUNTIME_CONTRACT, state: 'stale', online: false },
    });
  }

  observeRuntimeStatus(larkAppId: string, readiness: CurrentRuntimeStatus): void {
    const current = this.projections.get(larkAppId);
    this.projections.set(larkAppId, {
      projectionEpoch: current?.projectionEpoch ?? '',
      cursor: current?.cursor ?? 0,
      readiness: { ...readiness },
    });
  }

  runtimeStatusOf(larkAppId: string): CurrentRuntimeStatus | undefined {
    const status = this.projections.get(larkAppId)?.readiness;
    return status ? { ...status } : undefined;
  }
  hydrateSchedules(rows: Sched[]): void {
    for (const r of rows) this.schedules.set(r.id, r);
  }

  getSessions(): Row[] {
    const counts = new Map<string, number>();
    for (const row of this.sessions.values()) {
      counts.set(row.sessionId, (counts.get(row.sessionId) ?? 0) + 1);
    }
    // Existing dashboard consumers address rows by bare sessionId. Do not let
    // either owner overwrite/impersonate the other when those ids collide.
    return [...this.sessions.values()].filter(row => counts.get(row.sessionId) === 1);
  }
  getSessionForOwner(larkAppId: string, sessionId: string): Row | undefined {
    return this.sessions.get(this.sessionKey(larkAppId, sessionId));
  }
  getSession(sessionId: string): Row | undefined {
    const matches = this.sessionsMatching(sessionId);
    return matches.length === 1 ? matches[0] : undefined;
  }
  getSchedules(): Sched[] { return [...this.schedules.values()]; }

  /** sessionId → owning daemon's larkAppId (used for write routing). */
  ownerOf(sessionId: string): string | undefined {
    return this.getSession(sessionId)?.larkAppId;
  }

  /** sessionId → owning bot daemon's terminal reverse-proxy port. Used by the
   *  dashboard `/s/*` bridge to route a terminal request to the right daemon's
   *  proxy (each bot daemon runs its own terminal proxy on proxyBasePort+idx).
   *  undefined when the session is unknown or its daemon's proxy isn't up. */
  terminalProxyPortOf(sessionId: string): number | undefined {
    return this.getSession(sessionId)?.proxyPort as number | undefined;
  }

  /** Whether a session row with this id exists at all in the aggregator,
   *  regardless of `larkAppId` presence. Mirrors `scheduleExists`; lets
   *  the Route B write gate tell apart "legacy row with no owner" from
   *  "unknown id" so the close/resume/locate handler can route legacy rows
   *  to the caller's bot instead of 404'ing them. */
  sessionExists(sessionId: string): boolean {
    return this.sessionsMatching(sessionId).length > 0;
  }
  scheduleOwnerOf(id: string): string | undefined {
    return (this.schedules.get(id) as { larkAppId?: string } | undefined)?.larkAppId;
  }

  /** Whether a schedule row with this id exists at all in the aggregator,
   *  regardless of `larkAppId` presence. Used by the Route B write gate to
   *  distinguish a "legacy row with no owner" from a genuinely "unknown id"
   *  — the former should still proxy somewhere (the caller's bot), the
   *  latter is a 404 (codex 2026-06-10 schedules slice 2a blocker). */
  scheduleExists(id: string): boolean {
    return this.schedules.has(id);
  }

  on(fn: (e: DashboardEvent & { larkAppId: string }) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

/**
 * Subscribe to one daemon's SSE stream and feed events into the aggregator.
 * Auto-reconnects on error with 1s backoff. Returns an abort function.
 */
export function subscribeDaemon(
  d: DaemonInfo,
  agg: Aggregator,
  onError: (e: Error) => void,
  fetchImpl: typeof fetch = fetch,
  rebuild?: () => Promise<void>,
): () => void {
  const ctrl = new AbortController();
  const url = `http://127.0.0.1:${d.ipcPort}/api/events`;

  (async () => {
    while (!ctrl.signal.aborted) {
      try {
        const res = await fetchImpl(url, { signal: ctrl.signal });
        if (!res.ok || !res.body) throw new Error(`bad status ${res.status}`);
        // The daemon subscribes its EventBus before flushing SSE headers. Once
        // fetch resolves, rebuild under that live tail on every connection —
        // including the first — so the snapshot→subscribe window cannot lose
        // an otherwise-last event. Buffered events at/below the rebuilt cursor
        // are then ignored, and later contiguous events apply normally.
        if (rebuild) await rebuild();
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        let evt = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (line.startsWith('event:')) evt = line.slice(6).trim();
            else if (line.startsWith('data:') && evt) {
              const data = line.slice(5).trim();
              let body: any;
              try {
                body = JSON.parse(data);
              } catch {
                // Skip malformed frame
                evt = '';
                continue;
              }
              if (evt === 'session.spawned' && d.botAvatarUrl && body?.session) {
                body.session = { ...body.session, botAvatarUrl: d.botAvatarUrl };
              }
              if (evt.startsWith('session.')) {
                const projectionEpoch = body?.projectionEpoch;
                const sequence = body?.sequence;
                if (typeof projectionEpoch !== 'string' || !Number.isSafeInteger(sequence)) {
                  if (rebuild) await rebuild();
                  evt = '';
                  continue;
                }
                delete body.projectionEpoch;
                delete body.sequence;
                const result = agg.applyEvent(d.larkAppId, {
                  type: evt,
                  body,
                  projectionEpoch,
                  sequence,
                } as DashboardEvent);
                if (result === 'rebuildRequired' && rebuild) await rebuild();
              } else {
                agg.applyEvent(d.larkAppId, { type: evt, body } as DashboardEvent);
              }
              evt = '';
            }
          }
        }
      } catch (e) {
        if (!ctrl.signal.aborted) onError(e as Error);
        await new Promise(r => setTimeout(r, 1_000));
      }
    }
  })();

  return () => ctrl.abort();
}
