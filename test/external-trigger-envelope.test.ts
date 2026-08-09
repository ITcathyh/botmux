import { describe, expect, it } from 'vitest';
import {
  compileExternalTrigger,
  externalTriggerBusinessInput,
} from '../src/core/external-trigger-envelope.js';
import type { TriggerRequest } from '../src/services/trigger-types.js';

function request(): TriggerRequest {
  return {
    source: { type: 'webhook', connectorId: 'alerts' },
    target: { kind: 'turn', botId: 'cli_test' },
    envelope: {
      format: 'json',
      sourceName: 'alerts',
      trusted: false,
      payload: { severity: 'high' },
    },
    instruction: 'Summarize the alert',
    options: {
      asyncReturnSessionId: true,
      idempotencyKey: 'transport-only-key',
      status: 'firing',
    },
  };
}

describe('external trigger canonical envelope', () => {
  it('uses one key-free business input for both hashing callers and rendering', () => {
    const input = externalTriggerBusinessInput(request());
    const compiled = compileExternalTrigger(input, 'trg_1');

    expect(input.options).not.toHaveProperty('idempotencyKey');
    expect(compiled.prompt).not.toContain('transport-only-key');
    expect(compiled.prompt).not.toContain('idempotencyKey');
    expect(compiled.prompt).toContain('"status": "firing"');
    expect(compiled.applicationContext).toContain('Summarize the alert');
    expect(compiled.messageContext).not.toContain('Summarize the alert');
  });

  it('keeps high-frequency meeting raw text out of escaped JSON while preserving it as data', () => {
    const req = request();
    req.source.type = 'vc_meeting';
    req.envelope.rawText = 'first line\nsecond line';
    const compiled = compileExternalTrigger(externalTriggerBusinessInput(req), 'trg_vc');

    expect(compiled.messageContext).toContain('first line\nsecond line');
    expect(compiled.messageContext).not.toContain('first line\\nsecond line');
  });
});
