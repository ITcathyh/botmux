import { describe, expect, it } from 'vitest';

import {
  createCurrentOrdinaryImTurnPreparationPort,
  type OrdinaryImVcTurnOrigin,
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
    sender: { kind: 'human', openId: 'ou_sender', unionId: 'on_sender' },
    mentions: [{
      key: '@_user_1',
      name: 'Reviewer',
      openId: 'ou_reviewer',
      userId: 'u_reviewer',
      unionId: 'on_reviewer',
      appId: 'cli_reviewer',
    }],
    postParticipantMentions: [],
    resources: [{
      type: 'image',
      resourceKey: 'img_resource_1',
      name: 'image.png',
    }],
    messageListener: false,
    vc: { contextMayLag: false },
  };
}

function preparedEnvelope() {
  const input = transportEnvelope();
  return {
    ...input,
    resources: input.resources.map(resource => ({
      ...resource,
      sourceMessageKey: input.messageKey,
    })),
  };
}

function vcTurnOrigin(messageKey = 'om_message_1'): OrdinaryImVcTurnOrigin {
  return {
    listenerAppId: 'cli_listener',
    meetingId: 'meeting_1',
    memberId: 'minutes',
    memberEpoch: 3,
    agentAppId: 'cli_agent',
    ownerBootId: 'boot_1',
    ownerEpoch: 5,
    membershipGeneration: 7,
    sinkOwnerGeneration: 11,
    receiverSessionId: 'session_receiver',
    larkMessageId: messageKey,
    replyTargetSenderOpenId: 'ou_reply_target',
  };
}

describe('Current ordinary IM turn preparation', () => {
  it('freezes every state-neutral production fact needed by an ordinary existing-route turn', () => {
    const port = createCurrentOrdinaryImTurnPreparationPort();
    const input = {
      route: {
        scope: 'chat',
        canonicalAnchor: 'oc_chat',
        chatId: 'oc_chat',
        chatType: 'group',
      },
      source: 'lark.im',
      messageKey: 'om_message_1',
      content: 'first turn',
      quotedMessageKey: 'om_quoted',
      replyRootMessageKey: 'om_reply_root',
      sender: { kind: 'bot', openId: 'ou_sender', unionId: 'on_sender' },
      mentions: [{
        key: '@_user_1',
        name: 'Reviewer',
        openId: 'ou_reviewer',
        userId: 'u_reviewer',
        unionId: 'on_reviewer',
        appId: 'cli_reviewer',
      }],
      postParticipantMentions: [{
        key: '@_post_at_1',
        name: 'Peer bot',
        appId: 'cli_peer',
      }],
      resources: [{
        type: 'image',
        resourceKey: 'img_resource_1',
        sourceMessageKey: 'om_folded_source',
        name: 'image.png',
      }],
      rewrite: { kind: 'workflowGrill', goal: 'ship the production cut' },
      substitute: {
        target: { name: 'Reviewer', openId: 'ou_target', userId: 'u_target', unionId: 'on_target' },
        observedMention: {
          name: 'Observed reviewer',
          openId: 'ou_observed',
          userId: 'u_observed',
          unionId: 'on_observed',
        },
        disclosure: 'none',
      },
      messageListener: true,
      vc: { contextMayLag: true, lifecycle: 'sealed' },
    } as const satisfies OrdinaryImTransportEnvelope;

    const result = port.prepare(input);

    expect(result).toEqual({ kind: 'prepared', turn: input });
    if (result.kind !== 'prepared') throw new Error('expected prepared turn');
    expect(Object.isFrozen(result.turn)).toBe(true);
    expect(Object.isFrozen(result.turn.sender)).toBe(true);
    expect(Object.isFrozen(result.turn.mentions)).toBe(true);
    expect(Object.isFrozen(result.turn.mentions[0])).toBe(true);
    expect(Object.isFrozen(result.turn.postParticipantMentions)).toBe(true);
    expect(Object.isFrozen(result.turn.postParticipantMentions[0])).toBe(true);
    expect(Object.isFrozen(result.turn.resources)).toBe(true);
    expect(Object.isFrozen(result.turn.resources[0])).toBe(true);
    expect(Object.isFrozen(result.turn.rewrite)).toBe(true);
    expect(Object.isFrozen(result.turn.substitute)).toBe(true);
    expect(Object.isFrozen(result.turn.substitute?.target)).toBe(true);
    expect(Object.isFrozen(result.turn.substitute?.observedMention)).toBe(true);
    expect(Object.isFrozen(result.turn.vc)).toBe(true);

    (input as any).postParticipantMentions[0].appId = 'cli_changed';
    (input as any).rewrite.goal = 'changed goal';
    (input as any).substitute.target.openId = 'ou_changed';
    (input as any).substitute.observedMention.name = 'Changed';
    (input as any).vc.lifecycle = 'active';
    expect(result.turn.postParticipantMentions[0]?.appId).toBe('cli_peer');
    expect(result.turn.rewrite?.goal).toBe('ship the production cut');
    expect(result.turn.substitute?.target.openId).toBe('ou_target');
    expect(result.turn.substitute?.observedMention?.name).toBe('Observed reviewer');
    expect(result.turn.vc.lifecycle).toBe('sealed');
  });

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
    expect(Object.isFrozen(result.turn.resources)).toBe(true);
    expect(Object.isFrozen(result.turn.resources[0])).toBe(true);
    expect(Object.isFrozen(result.turn.mentions)).toBe(true);
    expect(Object.isFrozen(result.turn.mentions[0])).toBe(true);
    expect(Object.isFrozen(result.turn.postParticipantMentions)).toBe(true);
    expect(Object.isFrozen(result.turn.vc)).toBe(true);

    (input.route as any).canonicalAnchor = 'om_other';
    (input.sender as any).openId = 'ou_other';
    (input.resources as any[])[0]!.resourceKey = 'img_replaced';
    (input.mentions as any[])[0]!.name = 'Changed';
    expect(result.turn).toEqual(preparedEnvelope());
  });

  it('preserves an explicit folded resource source message identity', () => {
    const port = createCurrentOrdinaryImTurnPreparationPort();
    const input = transportEnvelope();
    (input.resources[0] as any).sourceMessageKey = 'om_folded_source';

    const result = port.prepare(input);

    expect(result).toMatchObject({
      kind: 'prepared',
      turn: {
        resources: [{ sourceMessageKey: 'om_folded_source' }],
      },
    });
  });

  it.each([
    ['the current message', 'messageKey'],
    ['the thread root', 'canonicalAnchor'],
  ] as const)('canonicalizes a quote of %s to the same hash-ready turn as no quote', (_label, source) => {
    const port = createCurrentOrdinaryImTurnPreparationPort();
    const omitted = transportEnvelope();
    const quoted = {
      ...transportEnvelope(),
      quotedMessageKey: source === 'messageKey'
        ? omitted.messageKey
        : omitted.route.canonicalAnchor,
    };

    const omittedResult = port.prepare(omitted);
    const quotedResult = port.prepare(quoted);

    expect(omittedResult).toMatchObject({ kind: 'prepared' });
    expect(quotedResult).toEqual(omittedResult);
  });

  it('canonicalizes a thread-scoped reply root that cannot affect reply placement', () => {
    const port = createCurrentOrdinaryImTurnPreparationPort();
    const omitted = transportEnvelope();
    const withNoopReplyRoot = {
      ...transportEnvelope(),
      replyRootMessageKey: 'om_chat_scope_only',
    };

    expect(port.prepare(withNoopReplyRoot)).toEqual(port.prepare(omitted));
  });

  it('canonicalizes omitted resource sources, substitute disclosure, and optional fields', () => {
    const port = createCurrentOrdinaryImTurnPreparationPort();
    const omitted = {
      ...transportEnvelope(),
      substitute: { target: { openId: 'ou_target' } },
    };
    const explicit = {
      ...transportEnvelope(),
      quotedMessageKey: '',
      replyRootMessageKey: undefined,
      resources: transportEnvelope().resources.map(resource => ({
        ...resource,
        sourceMessageKey: omitted.messageKey,
      })),
      substitute: {
        target: { openId: 'ou_target' },
        observedMention: undefined,
        disclosure: 'prefix' as const,
      },
    };

    expect(port.prepare(explicit)).toEqual(port.prepare(omitted));
  });

  it('canonicalizes an active VC lifecycle to the no-op default', () => {
    const port = createCurrentOrdinaryImTurnPreparationPort();
    const omitted = transportEnvelope();
    const active = {
      ...transportEnvelope(),
      vc: { contextMayLag: false, lifecycle: 'active' as const },
    };

    expect(port.prepare(active)).toEqual(port.prepare(omitted));
  });

  it.each(['sequence', 'claim', 'generation', 'worker', 'session', 'sessionId', 'authority'])(
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

  it('preserves the complete VC routing snapshot as detached, frozen, hash-ready input', () => {
    const port = createCurrentOrdinaryImTurnPreparationPort();
    const input = transportEnvelope() as any;
    input.vc.imTurnOrigin = vcTurnOrigin(input.messageKey);

    const result = port.prepare(input);

    expect(result).toMatchObject({
      kind: 'prepared',
      turn: { vc: { imTurnOrigin: input.vc.imTurnOrigin } },
    });
    if (result.kind !== 'prepared') throw new Error('expected prepared turn');
    expect(Object.isFrozen(result.turn.vc.imTurnOrigin)).toBe(true);
    expect(JSON.parse(JSON.stringify(result.turn.vc.imTurnOrigin))).toEqual({
      listenerAppId: 'cli_listener',
      meetingId: 'meeting_1',
      memberId: 'minutes',
      memberEpoch: 3,
      agentAppId: 'cli_agent',
      ownerBootId: 'boot_1',
      ownerEpoch: 5,
      membershipGeneration: 7,
      sinkOwnerGeneration: 11,
      receiverSessionId: 'session_receiver',
      larkMessageId: input.messageKey,
      replyTargetSenderOpenId: 'ou_reply_target',
    });

    input.vc.imTurnOrigin.ownerEpoch = 99;
    expect(result.turn.vc.imTurnOrigin.ownerEpoch).toBe(5);
  });

  it('rejects a VC routing snapshot for a different Lark message', () => {
    const port = createCurrentOrdinaryImTurnPreparationPort();
    const input = transportEnvelope() as any;
    input.vc.imTurnOrigin = vcTurnOrigin('om_different_message');

    expect(port.prepare(input)).toEqual({
      kind: 'rejected',
      reason: 'invalidTransportIdentity',
      message: 'ordinary IM VC turn origin.larkMessageId must equal ordinary IM messageKey',
    });
  });

  it.each([
    'listenerAppId',
    'meetingId',
    'memberId',
    'agentAppId',
    'ownerBootId',
    'receiverSessionId',
    'larkMessageId',
    'replyTargetSenderOpenId',
  ] as const)('rejects an inexact VC routing identity in %s', (field) => {
    const port = createCurrentOrdinaryImTurnPreparationPort();
    const input = transportEnvelope() as any;
    input.vc.imTurnOrigin = vcTurnOrigin(input.messageKey);
    input.vc.imTurnOrigin[field] = ` ${input.vc.imTurnOrigin[field]}`;

    const result = port.prepare(input);

    expect(result).toMatchObject({ kind: 'rejected', reason: 'invalidTransportIdentity' });
  });

  it.each([
    ['memberEpoch', 0],
    ['memberEpoch', 1.5],
    ['memberEpoch', Number.MAX_SAFE_INTEGER + 1],
    ['ownerEpoch', 0],
    ['ownerEpoch', 1.5],
    ['ownerEpoch', Number.MAX_SAFE_INTEGER + 1],
    ['membershipGeneration', 0],
    ['membershipGeneration', 1.5],
    ['membershipGeneration', Number.MAX_SAFE_INTEGER + 1],
    ['sinkOwnerGeneration', 0],
    ['sinkOwnerGeneration', 1.5],
    ['sinkOwnerGeneration', Number.MAX_SAFE_INTEGER + 1],
  ] as const)('rejects invalid VC routing integer %s=%s', (field, value) => {
    const port = createCurrentOrdinaryImTurnPreparationPort();
    const input = transportEnvelope() as any;
    input.vc.imTurnOrigin = vcTurnOrigin(input.messageKey);
    input.vc.imTurnOrigin[field] = value;

    const result = port.prepare(input);

    expect(result).toMatchObject({ kind: 'rejected', reason: 'invalidEnvelope' });
    if (result.kind !== 'rejected') throw new Error('expected rejected turn');
    expect(result.message).toContain(`${field} must be a positive safe integer`);
  });

  it.each([
    'listenerAppId',
    'meetingId',
    'memberId',
    'memberEpoch',
    'agentAppId',
    'ownerBootId',
    'ownerEpoch',
    'membershipGeneration',
    'sinkOwnerGeneration',
    'receiverSessionId',
    'larkMessageId',
    'replyTargetSenderOpenId',
  ] as const)('rejects a VC routing field %s exposed through an accessor', (field) => {
    const port = createCurrentOrdinaryImTurnPreparationPort();
    const input = transportEnvelope() as any;
    input.vc.imTurnOrigin = vcTurnOrigin(input.messageKey);
    const value = input.vc.imTurnOrigin[field];
    Object.defineProperty(input.vc.imTurnOrigin, field, {
      enumerable: true,
      get: () => value,
    });

    const result = port.prepare(input);

    expect(result).toMatchObject({ kind: 'rejected', reason: 'invalidEnvelope' });
    if (result.kind !== 'rejected') throw new Error('expected rejected turn');
    expect(result.message).toContain(`${field} must be detached data`);
  });

  it.each([
    {
      label: 'a Proxy',
      mutate(input: any) {
        input.vc.imTurnOrigin = new Proxy(vcTurnOrigin(input.messageKey), {});
      },
      message: /turn origin must not be a Proxy/i,
    },
    {
      label: 'a custom prototype',
      mutate(input: any) {
        input.vc.imTurnOrigin = Object.assign(
          Object.create({ fabricated: true }),
          vcTurnOrigin(input.messageKey),
        );
      },
      message: /turn origin must be a plain object/i,
    },
    {
      label: 'an extra symbol',
      mutate(input: any) {
        input.vc.imTurnOrigin = vcTurnOrigin(input.messageKey);
        input.vc.imTurnOrigin[Symbol('fabricated')] = true;
      },
      message: /turn origin contains unsupported symbol field/i,
    },
    {
      label: 'an extra string field',
      mutate(input: any) {
        input.vc.imTurnOrigin = { ...vcTurnOrigin(input.messageKey), fabricated: true };
      },
      message: /turn origin contains unsupported field: fabricated/i,
    },
  ])('rejects a VC routing snapshot carrying $label', ({ mutate, message }) => {
    const port = createCurrentOrdinaryImTurnPreparationPort();
    const input = transportEnvelope() as any;
    mutate(input);

    const result = port.prepare(input);

    expect(result).toMatchObject({ kind: 'rejected' });
    if (result.kind !== 'rejected') throw new Error('expected rejected turn');
    expect(result.message).toMatch(message);
  });

  it('rejects local resource paths at the state-neutral preparation seam', () => {
    const port = createCurrentOrdinaryImTurnPreparationPort();
    const input = transportEnvelope() as any;
    input.resources[0].path = '/tmp/private/image.png';

    expect(port.prepare(input)).toEqual({
      kind: 'rejected',
      reason: 'unsafeField',
      message: 'ordinary IM resource descriptor contains unsupported field: path',
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
      label: 'a proxied post-participant list',
      mutate: (input: any) => {
        input.postParticipantMentions = new Proxy(input.postParticipantMentions, {});
      },
      message: /post participant mentions must be an exact Array/i,
    },
    {
      label: 'an accessor workflow goal',
      mutate: (input: any) => {
        input.rewrite = { kind: 'workflowGrill', goal: 'goal' };
        Object.defineProperty(input.rewrite, 'goal', { enumerable: true, get: () => 'goal' });
      },
      message: /rewrite\.goal must be detached data/i,
    },
    {
      label: 'a custom-prototype substitute target',
      mutate: (input: any) => {
        input.substitute = {
          target: Object.assign(Object.create({ ownerEpoch: 7 }), { openId: 'ou_target' }),
        };
      },
      message: /substitute target identity must be a plain object/i,
    },
    {
      label: 'a symbolic VC field',
      mutate: (input: any) => { input.vc[Symbol('owner')] = 'forged'; },
      message: /VC context contains unsupported symbol field/i,
    },
  ])('rejects newly exposed nested facts carrying $label', ({ mutate, message }) => {
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
        class FabricatedResources extends Array {}
        input.resources = new FabricatedResources(...input.resources);
      },
      message: /resources must be an exact Array/i,
    },
    {
      label: 'an extra enumerable string field',
      mutate: (input: any) => { input.resources.fabricated = true; },
      message: /resources contains unsupported field: fabricated/i,
    },
    {
      label: 'an extra non-enumerable field',
      mutate: (input: any) => {
        Object.defineProperty(input.resources, 'fabricated', { value: true });
      },
      message: /resources contains unsupported field: fabricated/i,
    },
    {
      label: 'an extra symbol field',
      mutate: (input: any) => { input.resources[Symbol('fabricated')] = true; },
      message: /resources contains unsupported symbol field/i,
    },
    {
      label: 'an accessor element',
      mutate: (input: any) => {
        const first = input.resources[0];
        Object.defineProperty(input.resources, '0', { enumerable: true, get: () => first });
      },
      message: /resources\[0\] must be detached data/i,
    },
    {
      label: 'a sparse element',
      mutate: (input: any) => { delete input.resources[0]; },
      message: /resources\[0\] is missing/i,
    },
  ])('rejects resource lists carrying $label', ({ mutate, message }) => {
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
      'mentions',
      'postParticipantMentions',
      'resources',
      'messageListener',
      'vc',
    ]);
    const serialized = JSON.stringify(result.turn);
    for (const field of [
      'sequence',
      'claim',
      'generation',
      'worker',
      'session',
      'sessionId',
      'authority',
      'imTurnOrigin',
      'receiverSessionId',
      'ownerEpoch',
      'path',
      'command',
    ]) {
      expect(serialized).not.toContain(`"${field}"`);
    }
  });
});
