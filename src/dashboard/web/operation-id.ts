export type BrowserCryptoLike = {
  randomUUID?: () => string;
  getRandomValues?: (array: Uint8Array) => Uint8Array;
};

let fallbackSequence = 0;

function currentCrypto(): BrowserCryptoLike | undefined {
  try {
    return globalThis.crypto;
  } catch {
    return undefined;
  }
}

function randomToken(cryptoApi: BrowserCryptoLike | undefined): string {
  if (typeof cryptoApi?.randomUUID === 'function') {
    try { return cryptoApi.randomUUID.call(cryptoApi); } catch { /* insecure context */ }
  }
  if (typeof cryptoApi?.getRandomValues === 'function') {
    try {
      const bytes = cryptoApi.getRandomValues.call(cryptoApi, new Uint8Array(16));
      return Array.from(bytes as Uint8Array, byte => byte.toString(16).padStart(2, '0')).join('');
    } catch { /* fall through to the non-cryptographic uniqueness fallback */ }
  }
  fallbackSequence = (fallbackSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `${Date.now().toString(36)}-${fallbackSequence.toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Generate a retry identity without assuming randomUUID is available. The
 * fallback is an idempotency nonce, not an authentication secret. */
export function createSessionOperationId(
  kind: string,
  sessionId: string,
  cryptoApi: BrowserCryptoLike | undefined = currentCrypto(),
): string {
  return `${kind}:${sessionId}:${randomToken(cryptoApi)}`;
}

export type SemanticOperationDisposition = 'completed' | 'retryable' | 'unknown';

export type SemanticOperationLease = {
  readonly kind: 'ready';
  readonly operationId: string;
  readonly key: string;
  readonly semantic: string;
} | {
  readonly kind: 'blocked';
  readonly operationId: string;
  readonly reason: 'outcome_unknown';
  readonly key?: never;
  readonly semantic?: never;
};

type SemanticOperationEntry = {
  readonly semantic: string;
  readonly operationId: string;
  state: 'inflight' | 'retryable' | 'unknown';
};

function semanticInput(value: unknown): string {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? String(value) : serialized;
}

/** Page-lifetime operation identity registry. Retryable outcomes keep their
 * key, response-loss outcomes are quarantined, and a changed semantic request
 * starts a distinct operation. */
export class SemanticOperationCoordinator {
  readonly #entries = new Map<string, SemanticOperationEntry>();

  constructor(
    private readonly createId: (kind: string, target: string) => string = createSessionOperationId,
  ) {}

  begin(kind: string, target: string, input: unknown): SemanticOperationLease {
    const key = `${kind}\0${target}`;
    const semantic = semanticInput(input);
    const prior = this.#entries.get(key);
    if (prior && prior.semantic === semantic) {
      if (prior.state === 'unknown') {
        return {
          kind: 'blocked',
          operationId: prior.operationId,
          reason: 'outcome_unknown',
        };
      }
      prior.state = 'inflight';
      return { kind: 'ready', operationId: prior.operationId, key, semantic };
    }
    const operationId = this.createId(kind, target);
    this.#entries.set(key, { semantic, operationId, state: 'inflight' });
    return { kind: 'ready', operationId, key, semantic };
  }

  finish(lease: SemanticOperationLease, disposition: SemanticOperationDisposition): void {
    if (lease.kind !== 'ready') return;
    const current = this.#entries.get(lease.key);
    if (
      !current
      || current.operationId !== lease.operationId
      || current.semantic !== lease.semantic
    ) return;
    if (disposition === 'completed') {
      this.#entries.delete(lease.key);
      return;
    }
    current.state = disposition;
  }

  reconcile(kind: string, target: string): void {
    this.#entries.delete(`${kind}\0${target}`);
  }
}

const RETRYABLE_OPERATION_ERRORS = new Set([
  'agent_change_config_unavailable',
  'agent_change_not_wired',
  'agent_change_pending',
  'agent_change_preflight_unavailable',
  'dispatch_retryable',
  'session_runtime_not_ready',
  'session_runtime_unavailable',
  'session_transferring',
]);

function transientDisposition(code: string): Exclude<SemanticOperationDisposition, 'completed'> | null {
  if (code.includes('unknown') || code.includes('quarantin') || code.includes('ambiguous')) {
    return 'unknown';
  }
  if (RETRYABLE_OPERATION_ERRORS.has(code)) return 'retryable';
  return null;
}

function responseBodyEvidence(body: unknown): {
  readonly transient: Exclude<SemanticOperationDisposition, 'completed'> | null;
  readonly terminal: boolean;
  readonly opaqueFailure: boolean;
} {
  const stack: unknown[] = [body];
  const seen = new Set<object>();
  let transient: Exclude<SemanticOperationDisposition, 'completed'> | null = null;
  let terminal = false;
  let opaqueFailure = false;
  while (stack.length > 0) {
    const value = stack.pop();
    if (!value || typeof value !== 'object') continue;
    if (seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      stack.push(...value);
      continue;
    }
    const record = value as Record<string, unknown>;
    const stableCodes = [record.error, record.code].filter(
      (candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0,
    );
    if (stableCodes.length > 0) terminal = true;
    for (const code of stableCodes) {
      const disposition = transientDisposition(code);
      if (disposition === 'unknown') transient = 'unknown';
      else if (disposition === 'retryable' && transient !== 'unknown') transient = 'retryable';
    }
    if (record.kind === 'quarantined'
        || record.kind === 'ambiguous'
        || record.kind === 'unknown') {
      transient = 'unknown';
    } else if (record.kind === 'retryable' && transient !== 'unknown') {
      transient = 'retryable';
    }
    if (typeof record.ok === 'boolean') {
      if (record.ok) {
        terminal = true;
      } else if (stableCodes.length > 0) {
        terminal = true;
      } else {
        const results = Array.isArray(record.results) ? record.results : [];
        const hasExplainedFailure = results.some(result => (
          !!result
          && typeof result === 'object'
          && (result as Record<string, unknown>).ok === false
        ));
        if (!hasExplainedFailure) opaqueFailure = true;
      }
    }
    stack.push(...Object.values(record));
  }
  return { transient, terminal, opaqueFailure };
}

export function semanticOperationDisposition(input:
  | { readonly transportError: true }
  | { readonly status: number; readonly body: unknown }
): SemanticOperationDisposition {
  if ('transportError' in input) return 'unknown';
  const evidence = responseBodyEvidence(input.body);
  if (evidence.transient) return evidence.transient;
  if (evidence.opaqueFailure) return 'unknown';
  if (evidence.terminal) return 'completed';
  if (input.status >= 500) return 'unknown';
  if (input.status >= 400) return 'completed';
  return 'unknown';
}
