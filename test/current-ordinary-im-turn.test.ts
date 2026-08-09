import { describe, expect, it } from 'vitest';

import {
  createCurrentOrdinaryImTurnPreparationPort,
} from '../src/core/current-ordinary-im-turn.js';
import type { OrdinaryImTransportEnvelope } from '../src/core/ordinary-im-turn.js';

function transportEnvelope(): OrdinaryImTransportEnvelope {
  return {
    route: {
      scope: 'thread',
      canonicalAnchor: 'om_root',
      chatId: 'oc_chat',
      chatType: 'group',
    },
    source: 'lark.im',
    messageKey: 'om_message_1',
    content: 'first turn',
    sender: { kind: 'human', openId: 'ou_sender', name: 'Sender' },
    attachments: [{
      type: 'image',
      resourceKey: 'img_resource_1',
      name: 'image.png',
    }],
    mentions: [{ key: '@_user_1', name: 'Reviewer', openId: 'ou_reviewer', kind: 'human' }],
  };
}

function preparedEnvelope() {
  const input = transportEnvelope();
  return {
    ...input,
    attachments: input.attachments.map(attachment => ({
      ...attachment,
      sourceMessageKey: input.messageKey,
    })),
  };
}

describe('Current ordinary IM turn preparation', () => {
  it('compiles a detached, deeply immutable transport turn without Runtime state', () => {
    const port = createCurrentOrdinaryImTurnPreparationPort();
    const input = transportEnvelope();

    const result = port.prepare(input);

    expect(result).toEqual({
      kind: 'prepared',
      turn: preparedEnvelope(),
    });
    if (result.kind !== 'prepared') throw new Error('expected prepared turn');
    expect(Object.isFrozen(result.turn)).toBe(true);
    expect(Object.isFrozen(result.turn.route)).toBe(true);
    expect(Object.isFrozen(result.turn.sender)).toBe(true);
    expect(Object.isFrozen(result.turn.attachments)).toBe(true);
    expect(Object.isFrozen(result.turn.attachments[0])).toBe(true);
    expect(Object.isFrozen(result.turn.mentions)).toBe(true);
    expect(Object.isFrozen(result.turn.mentions[0])).toBe(true);

    (input.route as any).canonicalAnchor = 'om_other';
    (input.sender as any).openId = 'ou_other';
    (input.attachments as any[])[0]!.resourceKey = 'img_replaced';
    (input.mentions as any[])[0]!.name = 'Changed';
    expect(result.turn).toEqual(preparedEnvelope());
  });

  it('preserves an explicit folded attachment source message identity', () => {
    const port = createCurrentOrdinaryImTurnPreparationPort();
    const input = transportEnvelope();
    (input.attachments[0] as any).sourceMessageKey = 'om_folded_source';

    const result = port.prepare(input);

    expect(result).toMatchObject({
      kind: 'prepared',
      turn: {
        attachments: [{ sourceMessageKey: 'om_folded_source' }],
      },
    });
  });

  it.each(['sequence', 'claim', 'generation', 'worker', 'session'])(
    'rejects caller-provided %s authority instead of carrying it into preparation',
    (field) => {
      const port = createCurrentOrdinaryImTurnPreparationPort();
      const input = { ...transportEnvelope(), [field]: 'fabricated' } as any;

      expect(port.prepare(input)).toEqual({
        kind: 'rejected',
        reason: 'unsafeField',
        message: `ordinary IM transport envelope contains unsupported field: ${field}`,
      });
    },
  );

  it('rejects local attachment paths at the state-neutral preparation seam', () => {
    const port = createCurrentOrdinaryImTurnPreparationPort();
    const input = transportEnvelope() as any;
    input.attachments[0].path = '/tmp/private/image.png';

    expect(port.prepare(input)).toEqual({
      kind: 'rejected',
      reason: 'unsafeField',
      message: 'ordinary IM attachment descriptor contains unsupported field: path',
    });
  });

  it.each([
    {
      label: 'required envelope content',
      field: 'content',
      inherited: 'inherited content',
      mutate(input: any) { delete input.content; },
    },
    {
      label: 'optional sender identity',
      field: 'openId',
      inherited: 'ou_inherited',
      mutate(input: any) { delete input.sender.openId; },
    },
  ])('rejects $label inherited from Object.prototype', ({ field, inherited, mutate }) => {
    const port = createCurrentOrdinaryImTurnPreparationPort();
    const input = transportEnvelope() as any;
    const prior = Object.getOwnPropertyDescriptor(Object.prototype, field);
    Object.defineProperty(Object.prototype, field, {
      value: inherited,
      configurable: true,
    });
    try {
      mutate(input);
      const result = port.prepare(input);

      expect(result).toMatchObject({ kind: 'rejected' });
      if (result.kind !== 'rejected') throw new Error('expected rejected turn');
      expect(result.message).toMatch(/must be detached data/i);
    } finally {
      if (prior) Object.defineProperty(Object.prototype, field, prior);
      else Reflect.deleteProperty(Object.prototype, field);
    }
  });

  it('rejects a transparent Proxy instead of trusting virtual own descriptors', () => {
    const port = createCurrentOrdinaryImTurnPreparationPort();
    const input = transportEnvelope() as any;
    input.sender = new Proxy(input.sender, {});

    const result = port.prepare(input);

    expect(result).toMatchObject({ kind: 'rejected' });
    if (result.kind !== 'rejected') throw new Error('expected rejected turn');
    expect(result.message).toMatch(/proxy/i);
  });

  it.each([
    {
      label: 'a non-plain route prototype',
      mutate: (input: any) => {
        input.route = Object.assign(Object.create({ fabricated: true }), input.route);
      },
      message: /route must be a plain object/i,
    },
    {
      label: 'a non-enumerable route field',
      mutate: (input: any) => {
        Object.defineProperty(input.route, 'chatId', {
          value: input.route.chatId,
          enumerable: false,
        });
      },
      message: /route\.chatId must be detached data/i,
    },
    {
      label: 'an accessor route field',
      mutate: (input: any) => {
        const chatId = input.route.chatId;
        Object.defineProperty(input.route, 'chatId', { enumerable: true, get: () => chatId });
      },
      message: /route\.chatId must be detached data/i,
    },
    {
      label: 'a symbol route field',
      mutate: (input: any) => { input.route[Symbol('fabricated')] = true; },
      message: /route contains unsupported symbol field/i,
    },
  ])('rejects transport records carrying $label', ({ mutate, message }) => {
    const port = createCurrentOrdinaryImTurnPreparationPort();
    const input = transportEnvelope() as any;
    mutate(input);

    const result = port.prepare(input);

    expect(result).toMatchObject({ kind: 'rejected' });
    if (result.kind !== 'rejected') throw new Error('expected rejected turn');
    expect(result.message).toMatch(message);
  });

  it.each([
    {
      label: 'an Array subclass',
      mutate: (input: any) => {
        class FabricatedAttachments extends Array {}
        input.attachments = new FabricatedAttachments(...input.attachments);
      },
      message: /attachments must be an exact Array/i,
    },
    {
      label: 'an extra enumerable string field',
      mutate: (input: any) => { input.attachments.fabricated = true; },
      message: /attachments contains unsupported field: fabricated/i,
    },
    {
      label: 'an extra non-enumerable field',
      mutate: (input: any) => {
        Object.defineProperty(input.attachments, 'fabricated', { value: true });
      },
      message: /attachments contains unsupported field: fabricated/i,
    },
    {
      label: 'an extra symbol field',
      mutate: (input: any) => { input.attachments[Symbol('fabricated')] = true; },
      message: /attachments contains unsupported symbol field/i,
    },
    {
      label: 'an accessor element',
      mutate: (input: any) => {
        const first = input.attachments[0];
        Object.defineProperty(input.attachments, '0', { enumerable: true, get: () => first });
      },
      message: /attachments\[0\] must be detached data/i,
    },
    {
      label: 'a sparse element',
      mutate: (input: any) => { delete input.attachments[0]; },
      message: /attachments\[0\] is missing/i,
    },
  ])('rejects attachment lists carrying $label', ({ mutate, message }) => {
    const port = createCurrentOrdinaryImTurnPreparationPort();
    const input = transportEnvelope() as any;
    mutate(input);

    const result = port.prepare(input);

    expect(result).toMatchObject({ kind: 'rejected' });
    if (result.kind !== 'rejected') throw new Error('expected rejected turn');
    expect(result.message).toMatch(message);
  });

  it('publishes no ordering, claim, generation, Session, worker, path, or Runtime command field', () => {
    const port = createCurrentOrdinaryImTurnPreparationPort();
    const result = port.prepare(transportEnvelope());
    if (result.kind !== 'prepared') throw new Error('expected prepared turn');

    expect(Object.getOwnPropertyNames(result.turn)).toEqual([
      'route',
      'source',
      'messageKey',
      'content',
      'sender',
      'attachments',
      'mentions',
    ]);
    const serialized = JSON.stringify(result.turn);
    for (const field of ['sequence', 'claim', 'generation', 'worker', 'session', 'path', 'command']) {
      expect(serialized).not.toContain(`"${field}"`);
    }
  });
});
