import { describe, expect, it } from 'vitest';

import { compileLarkOrdinaryImTurn } from '../src/im/lark/ordinary-im-turn-adapter.js';

function listenerMatch() {
  return {
    name: 'Alert listener',
    replyCardTitle: 'Production alert',
    prompt: 'Investigate this alert.',
    workingDir: '/repos/alert-service',
    messageText: 'disk pressure',
    messageTitle: 'Disk pressure',
    msgType: 'interactive',
    senderOpenId: 'ou_alert_bot',
    senderName: 'Alert Bot',
    senderType: 'bot' as const,
  };
}

describe('Lark ordinary IM turn transport Adapter', () => {
  it('compiles the minimum detached Lark facts into one canonical ordinary turn', () => {
    const turn = compileLarkOrdinaryImTurn({
      route: {
        scope: 'thread',
        canonicalAnchor: 'om_root',
        chatId: 'oc_chat',
        chatType: 'group',
      },
      message: {
        messageId: 'om_message',
        parentId: 'om_root',
        senderId: 'ou_human',
        senderUnionId: 'on_human',
        senderType: 'user',
        content: 'hello from Lark',
      },
      replyRootMessageKey: 'om_root',
      resources: [],
      senderPeerBotRecognized: false,
      postParticipantMentions: [],
      foldedForwardContext: false,
      vcMeetingContextMayLag: false,
    });

    expect(turn).toEqual({
      route: {
        scope: 'thread',
        canonicalAnchor: 'om_root',
        chatId: 'oc_chat',
        chatType: 'group',
      },
      source: 'lark.im',
      messageKey: 'om_message',
      content: 'hello from Lark',
      sender: {
        kind: 'human',
        openId: 'ou_human',
        unionId: 'on_human',
      },
      mentions: [],
      postParticipantMentions: [],
      resources: [],
      foldedForwardContext: false,
      vc: { contextMayLag: false },
    });
  });

  it.each([
    {
      scope: 'chat' as const,
      canonicalAnchor: 'oc_chat',
      replyRootMessageKey: 'om_top_level_substitute',
      expected: 'om_top_level_substitute',
    },
    {
      scope: 'thread' as const,
      canonicalAnchor: 'om_thread_root',
      replyRootMessageKey: 'om_thread_root',
      expected: undefined,
    },
  ])(
    'preserves the exact $scope reply target only when chat scope owns it',
    ({ scope, canonicalAnchor, replyRootMessageKey, expected }) => {
      const turn = compileLarkOrdinaryImTurn({
        route: {
          scope,
          canonicalAnchor,
          chatId: 'oc_chat',
          chatType: 'group',
        },
        message: {
          messageId: 'om_top_level_substitute',
          parentId: undefined,
          senderId: 'ou_human',
          senderType: 'user',
          content: 'reply routing',
        },
        replyRootMessageKey,
        resources: [],
        senderPeerBotRecognized: false,
        postParticipantMentions: [],
        foldedForwardContext: false,
        vcMeetingContextMayLag: false,
      });

      expect(turn.replyRootMessageKey).toBe(expected);
    },
  );

  it('maps every detached Lark business fact without provider-only mention fields', () => {
    const turn = compileLarkOrdinaryImTurn({
      route: {
        scope: 'chat',
        canonicalAnchor: 'oc_chat',
        chatId: 'oc_chat',
        chatType: 'p2p',
      },
      message: {
        messageId: 'om_full',
        parentId: 'om_quoted',
        senderId: 'ou_bot',
        senderUnionId: 'on_bot',
        senderType: 'app',
        content: 'full turn',
        mentions: [{
          key: '@_user_1',
          name: 'Human',
          openId: 'ou_mention',
          userId: 'u_mention',
          unionId: 'on_mention',
          appId: 'cli_mention',
          idType: 'open_id',
        }],
      },
      replyRootMessageKey: 'om_reply_root',
      resources: [
        { type: 'image', key: 'img_1', name: 'image.png' },
        { type: 'file', key: 'file_1', name: 'notes.txt', messageId: 'om_nested' },
      ],
      senderPeerBotRecognized: false,
      postParticipantMentions: [{
        key: '@_post_1',
        name: 'Peer Bot',
        appId: 'cli_peer',
        idType: 'app_id',
      }],
      workflowGoal: 'ship the transport seam',
      substituteTrigger: {
        target: {
          name: 'Configured target',
          openId: 'ou_target',
          userId: 'u_target',
          unionId: 'on_target',
        },
        observedMention: { name: 'Observed target', openId: 'ou_observed' },
        disclosure: 'none',
      },
      foldedForwardContext: false,
      messageListener: listenerMatch(),
      vcMeetingContextMayLag: true,
      vcMeetingContextLifecycle: 'sealed',
      vcMeetingImTurnOrigin: {
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
        larkMessageId: 'om_full',
        replyTargetSenderOpenId: 'ou_reply_target',
      },
    });

    expect(turn).toEqual({
      route: {
        scope: 'chat',
        canonicalAnchor: 'oc_chat',
        chatId: 'oc_chat',
        chatType: 'p2p',
      },
      source: 'lark.im',
      messageKey: 'om_full',
      content: 'full turn',
      quotedMessageKey: 'om_quoted',
      replyRootMessageKey: 'om_reply_root',
      sender: { kind: 'bot', openId: 'ou_bot', unionId: 'on_bot' },
      mentions: [{
        key: '@_user_1',
        name: 'Human',
        openId: 'ou_mention',
        userId: 'u_mention',
        unionId: 'on_mention',
        appId: 'cli_mention',
      }],
      postParticipantMentions: [{
        key: '@_post_1',
        name: 'Peer Bot',
        appId: 'cli_peer',
      }],
      resources: [
        {
          type: 'image',
          resourceKey: 'img_1',
          sourceMessageKey: 'om_full',
          name: 'image.png',
        },
        {
          type: 'file',
          resourceKey: 'file_1',
          sourceMessageKey: 'om_nested',
          name: 'notes.txt',
        },
      ],
      rewrite: { kind: 'workflowGrill', goal: 'ship the transport seam' },
      substitute: {
        target: {
          name: 'Configured target',
          openId: 'ou_target',
          userId: 'u_target',
          unionId: 'on_target',
        },
        observedMention: { name: 'Observed target', openId: 'ou_observed' },
        disclosure: 'none',
      },
      foldedForwardContext: false,
      messageListener: listenerMatch(),
      vc: {
        contextMayLag: true,
        lifecycle: 'sealed',
        imTurnOrigin: {
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
          larkMessageId: 'om_full',
          replyTargetSenderOpenId: 'ou_reply_target',
        },
      },
    });
  });

  it.each([
    { senderType: 'user', peer: false, expected: 'human' },
    { senderType: 'app', peer: false, expected: 'bot' },
    { senderType: 'bot', peer: false, expected: 'bot' },
    { senderType: 'legacy-peer-shape', peer: true, expected: 'bot' },
    { senderType: 'user', peer: true, expected: 'bot' },
    { senderType: 'unknown-provider-value', peer: false, expected: 'unknown' },
  ] as const)(
    'maps sender_type=$senderType peer=$peer to $expected',
    ({ senderType, peer, expected }) => {
      const turn = compileLarkOrdinaryImTurn({
        route: {
          scope: 'thread',
          canonicalAnchor: 'om_root',
          chatId: 'oc_chat',
          chatType: 'group',
        },
        message: {
          messageId: `om_${senderType}_${String(peer)}`,
          senderId: 'ou_sender',
          senderType,
          content: 'sender classification',
        },
        resources: [],
        senderPeerBotRecognized: peer,
        postParticipantMentions: [],
        foldedForwardContext: false,
        vcMeetingContextMayLag: false,
      });

      expect(turn.sender.kind).toBe(expected);
    },
  );

  it('delegates provider no-ops and semantic defaults to neutral canonicalization', () => {
    const turn = compileLarkOrdinaryImTurn({
      route: {
        scope: 'thread',
        canonicalAnchor: 'om_root',
        chatId: 'oc_chat',
        chatType: 'group',
      },
      message: {
        messageId: 'om_same',
        parentId: 'om_same',
        senderId: '',
        senderType: 'unclassified',
        content: '',
      },
      replyRootMessageKey: 'om_root',
      resources: [{ type: 'image', key: 'img_default', name: 'default.png' }],
      senderPeerBotRecognized: false,
      postParticipantMentions: [],
      substituteTrigger: { target: { name: 'Target' } },
      foldedForwardContext: false,
      vcMeetingContextMayLag: false,
      vcMeetingContextLifecycle: 'active',
    });

    expect(turn).toEqual({
      route: {
        scope: 'thread',
        canonicalAnchor: 'om_root',
        chatId: 'oc_chat',
        chatType: 'group',
      },
      source: 'lark.im',
      messageKey: 'om_same',
      content: '',
      sender: { kind: 'unknown' },
      mentions: [],
      postParticipantMentions: [],
      resources: [{
        type: 'image',
        resourceKey: 'img_default',
        sourceMessageKey: 'om_same',
        name: 'default.png',
      }],
      substitute: {
        target: { name: 'Target' },
        disclosure: 'prefix',
      },
      foldedForwardContext: false,
      vc: { contextMayLag: false },
    });
  });

  it('returns a deeply detached and frozen turn', () => {
    const route = {
      scope: 'chat' as const,
      canonicalAnchor: 'oc_chat',
      chatId: 'oc_chat',
      chatType: 'group' as const,
    };
    const mention = {
      key: '@_user_1',
      name: 'Mention before compile',
      openId: 'ou_mention',
      idType: 'open_id',
    };
    const postMention = {
      key: '@_post_1',
      name: 'Post before compile',
      appId: 'cli_peer',
      idType: 'app_id',
    };
    const resource = {
      type: 'file' as const,
      key: 'file_before',
      name: 'before.txt',
    };
    const substituteTrigger = {
      target: { name: 'Target before compile', openId: 'ou_target' },
      observedMention: { name: 'Observed before compile' },
      disclosure: 'prefix' as const,
    };
    const origin = {
      listenerAppId: 'cli_listener',
      meetingId: 'meeting_before',
      memberId: 'minutes',
      memberEpoch: 1,
      agentAppId: 'cli_agent',
      ownerBootId: 'boot_1',
      ownerEpoch: 1,
      membershipGeneration: 1,
      sinkOwnerGeneration: 1,
      receiverSessionId: 'session_receiver',
      larkMessageId: 'om_detached',
    };
    const message = {
      messageId: 'om_detached',
      parentId: 'om_quote',
      senderId: 'ou_sender',
      senderUnionId: 'on_sender',
      senderType: 'user',
      content: 'before compile',
      mentions: [mention],
    };

    const turn = compileLarkOrdinaryImTurn({
      route,
      message,
      replyRootMessageKey: 'om_reply_root',
      resources: [resource],
      senderPeerBotRecognized: false,
      postParticipantMentions: [postMention],
      workflowGoal: 'goal before compile',
      substituteTrigger,
      foldedForwardContext: false,
      messageListener: listenerMatch(),
      vcMeetingContextMayLag: true,
      vcMeetingContextLifecycle: 'sealed',
      vcMeetingImTurnOrigin: origin,
    });

    route.chatId = 'oc_changed';
    message.content = 'after compile';
    mention.name = 'Mention after compile';
    postMention.name = 'Post after compile';
    resource.key = 'file_after';
    substituteTrigger.target.name = 'Target after compile';
    origin.meetingId = 'meeting_after';

    expect(turn).toMatchObject({
      route: { chatId: 'oc_chat' },
      content: 'before compile',
      mentions: [{ name: 'Mention before compile' }],
      postParticipantMentions: [{ name: 'Post before compile' }],
      resources: [{ resourceKey: 'file_before' }],
      substitute: { target: { name: 'Target before compile' } },
      vc: { imTurnOrigin: { meetingId: 'meeting_before' } },
    });
    expect([
      turn,
      turn.route,
      turn.sender,
      turn.mentions,
      turn.mentions[0],
      turn.postParticipantMentions,
      turn.postParticipantMentions[0],
      turn.resources,
      turn.resources[0],
      turn.rewrite,
      turn.substitute,
      turn.substitute?.target,
      turn.substitute?.observedMention,
      turn.vc,
      turn.vc.imTurnOrigin,
    ].every(value => value === undefined || Object.isFrozen(value))).toBe(true);
  });
});
