import { writeFileSync, writeFileSync as persistFile } from 'node:fs';
import { join } from 'node:path';

import type { DaemonSession } from '../../../src/core/types.js';
import type { Session } from '../../../src/types.js';

declare const daemonSession: DaemonSession;
declare const daemonSessions: Map<string, DaemonSession>;
declare const session: Session;
declare const sessions: Session[];
declare const sessionKey: keyof Session;

export function directAndAliasedMutations(): void {
  session.forkChildSessionIds?.push('child');
  session['status'] = 'closed';
  session[sessionKey] = undefined as never;

  const setup = daemonSession.session.pendingRepoSetup;
  if (setup) setup.repoCardMessageId = 'message';
  const { pendingRepoSetup: destructuredSetup } = session;
  if (destructuredSetup) destructuredSetup.repoCardMessageId = 'destructured';

  let repoDirs = session.riffRepoDirs;
  repoDirs?.push('/repo');

  const origins = session.vcMeetingImTurnOrigins ??= {};
  origins.synthetic = undefined as never;
  for (const entry of session.queuedActivationTail ?? []) entry.order += 1;

  const recovered = [...(session.codexAppDispatchLedger ?? [])].reverse().find(() => true);
  if (recovered) recovered.queuedActivationToken = 'token';
  const matching = (session.codexAppDispatchLedger ?? []).filter(() => true);
  const retained = matching[0];
  if (retained) retained.replyTurnId = 'turn';

  const targets = daemonSession.session.docCommentTargets;
  if (targets) delete targets.turn;

  Object.assign(session, { title: 'renamed' });
  daemonSessions.set('session', daemonSession);
  daemonSessions.delete('session');
}

export function derivedCopiesAreNotMutations(): void {
  sessions.filter(candidate => candidate.status === 'active').sort(() => 0);
  [...(session.codexAppDispatchLedger ?? [])].reverse();
  [...(session.queuedActivationTail ?? [])].sort(() => 0);
}

export function syntheticRawSessionWriter(): void {
  writeFileSync('sessions-synthetic.json', '{}');
}

function syntheticSessionFilePath(): string {
  return join('/synthetic', 'sessions-helper.json');
}

export function helperBuiltAliasedRawSessionWriter(): void {
  const target = syntheticSessionFilePath();
  persistFile(target, '{}');
}

export function unrelatedRawWriter(): void {
  writeFileSync('unrelated.json', '{}');
}
