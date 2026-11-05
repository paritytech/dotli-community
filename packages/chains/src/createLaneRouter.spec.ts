// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createLaneRouter, type LaneConnectParams, type LaneHandle } from './createLaneRouter.js';

type FakeSession = {
  params: LaneConnectParams;
  sent: unknown[];
  disconnects: number;
};

type FakeLaneParams = {
  id: number;
  /** The local tokens a session on this lane holds. */
  tokens?: string[];
  /** Thrown by `connect`, as a lane that refuses a session does. */
  refusal?: Error;
  /** Thrown by a session's `disconnect` after it counted, as a lane whose close fails does. */
  disconnectFailure?: Error;
};

function createFakeLane({ id, tokens = [], refusal, disconnectFailure }: FakeLaneParams): {
  lane: LaneHandle;
  sessions: FakeSession[];
} {
  const sessions: FakeSession[] = [];
  const lane: LaneHandle = {
    id,
    hasToken: localToken => tokens.includes(localToken),
    connect(params) {
      if (refusal) {
        throw refusal;
      }
      const session: FakeSession = { params, sent: [], disconnects: 0 };
      sessions.push(session);
      return {
        send(message) {
          session.sent.push(message);
        },
        disconnect() {
          session.disconnects += 1;
          if (disconnectFailure) {
            throw disconnectFailure;
          }
        },
      };
    },
  };
  return { lane, sessions };
}

function createFollow(id: number): Record<string, unknown> {
  return { jsonrpc: '2.0', id, method: 'chainHead_v1_follow', params: [true] };
}

describe('createLaneRouter', () => {
  it('As a consumer, I connect and my session opens on my home lane under my own id', () => {
    // Given a home lane
    const home = createFakeLane({ id: 1 });
    const onMessage = (): void => {};

    // When I connect
    createLaneRouter({
      sessionId: 'consumer-1',
      onMessage,
      wireMode: 'object',
      home: home.lane,
      pickFollowLane: () => home.lane,
      getLaneSessionId: lane => `consumer-1@${String(lane.id)}`,
    });

    // Then one session opens on home, under my id, with my handler and wire mode
    expect(home.sessions.map(s => [s.params.sessionId, s.params.onMessage, s.params.wireMode])).toEqual([
      ['consumer-1', onMessage, 'object'],
    ]);
  });

  it('As a consumer, I send a request and it goes to my home lane as an object', () => {
    // Given a router on its home lane
    const home = createFakeLane({ id: 1 });
    const router = createLaneRouter({
      sessionId: 'consumer-1',
      onMessage: () => {},
      home: home.lane,
      pickFollowLane: () => home.lane,
      getLaneSessionId: lane => `consumer-1@${String(lane.id)}`,
    });
    const request = { jsonrpc: '2.0', id: 1, method: 'chainSpec_v1_genesisHash', params: [] };

    // When I send it as JSON text
    router.send(JSON.stringify(request));

    // Then home hears the parsed object
    expect(home.sessions[0]?.sent).toEqual([request]);
  });

  it('As a consumer whose home lane is full, I follow and my follow goes to the lane picked for it, under the session id given for that lane', () => {
    // Given a home lane with no room and an overflow lane
    const home = createFakeLane({ id: 1 });
    const overflow = createFakeLane({ id: 2 });
    const onMessage = (): void => {};
    const router = createLaneRouter({
      sessionId: 'consumer-1',
      onMessage,
      wireMode: 'object',
      home: home.lane,
      pickFollowLane: () => overflow.lane,
      getLaneSessionId: lane => `consumer-1@${String(lane.id)}`,
    });

    // When I follow twice
    router.send(createFollow(1));
    router.send(createFollow(2));

    // Then both follows reach one session on the overflow lane, under its own id, and none reaches home
    expect(overflow.sessions.map(s => [s.params.sessionId, s.params.onMessage, s.params.wireMode])).toEqual([
      ['consumer-1@2', onMessage, 'object'],
    ]);
    expect(overflow.sessions[0]?.sent).toEqual([createFollow(1), createFollow(2)]);
    expect(home.sessions[0]?.sent).toEqual([]);
  });

  it('As a consumer with a follow on another lane, I call on its token and the call goes to that lane', () => {
    // Given a follow that went to the overflow lane, which holds its token
    const home = createFakeLane({ id: 1 });
    const overflow = createFakeLane({ id: 2, tokens: ['follow-2'] });
    const router = createLaneRouter({
      sessionId: 'consumer-1',
      onMessage: () => {},
      home: home.lane,
      pickFollowLane: () => overflow.lane,
      getLaneSessionId: lane => `consumer-1@${String(lane.id)}`,
    });
    router.send(createFollow(1));
    const storage = { jsonrpc: '2.0', id: 2, method: 'chainHead_v1_storage', params: ['follow-2', '0xabc', []] };
    const other = { jsonrpc: '2.0', id: 3, method: 'chainHead_v1_storage', params: ['follow-1', '0xabc', []] };

    // When I call on that token, and on a token the overflow lane does not hold
    router.send(storage);
    router.send(other);

    // Then the first call follows its follow, and the second goes home
    expect(overflow.sessions[0]?.sent).toEqual([createFollow(1), storage]);
    expect(home.sessions[0]?.sent).toEqual([other]);
  });

  it('As a consumer, I send JSON text that does not parse and my home lane answers it', () => {
    // Given a router on its home lane
    const home = createFakeLane({ id: 1 });
    const router = createLaneRouter({
      sessionId: 'consumer-1',
      onMessage: () => {},
      home: home.lane,
      pickFollowLane: () => home.lane,
      getLaneSessionId: lane => `consumer-1@${String(lane.id)}`,
    });

    // When I send broken JSON text and a batch
    router.send('{"method":');
    router.send([createFollow(1)]);

    // Then home hears both as they came
    expect(home.sessions[0]?.sent).toEqual(['{"method":', [createFollow(1)]]);
  });

  it('As a consumer whose overflow lane refuses my session, I hear an error for my follow and nothing throws', () => {
    // Given an overflow lane that refuses the session
    const home = createFakeLane({ id: 1 });
    const overflow = createFakeLane({ id: 2, refusal: new Error('Duplicate broker session: consumer-1@2') });
    const heard: unknown[] = [];
    const router = createLaneRouter({
      sessionId: 'consumer-1',
      onMessage: message => {
        heard.push(message);
      },
      home: home.lane,
      pickFollowLane: () => overflow.lane,
      getLaneSessionId: lane => `consumer-1@${String(lane.id)}`,
    });

    // When I follow
    router.send(JSON.stringify(createFollow(7)));

    // Then I hear the refusal as JSON text under my follow's id, and home hears nothing
    expect(heard).toEqual([
      JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        error: { code: -32603, message: 'Duplicate broker session: consumer-1@2' },
      }),
    ]);
    expect(home.sessions[0]?.sent).toEqual([]);
  });

  it('As a consumer whose chain has no lane for my follow, I hear an error for it and nothing is sent', () => {
    // Given a chain with no lane that has room
    const home = createFakeLane({ id: 1 });
    const heard: unknown[] = [];
    const router = createLaneRouter({
      sessionId: 'consumer-1',
      onMessage: message => {
        heard.push(message);
      },
      wireMode: 'object',
      home: home.lane,
      pickFollowLane: () => null,
      getLaneSessionId: lane => `consumer-1@${String(lane.id)}`,
    });

    // When I follow
    router.send(createFollow(4));

    // Then I hear the error under my follow's id, and nothing is sent
    expect(heard).toEqual([
      { jsonrpc: '2.0', id: 4, error: { code: -32603, message: 'No lane can take a follow of consumer-1' } },
    ]);
    expect(home.sessions[0]?.sent).toEqual([]);
  });

  it('As a consumer, I hear a halt from two lanes and my halt handler runs once, with the first error', () => {
    // Given sessions on home and on an overflow lane
    const home = createFakeLane({ id: 1 });
    const overflow = createFakeLane({ id: 2 });
    const halts: unknown[] = [];
    const router = createLaneRouter({
      sessionId: 'consumer-1',
      onMessage: () => {},
      onHalt: error => {
        halts.push(error);
      },
      home: home.lane,
      pickFollowLane: () => overflow.lane,
      getLaneSessionId: lane => `consumer-1@${String(lane.id)}`,
    });
    router.send(createFollow(1));
    const first = new Error('overflow halted');
    const second = new Error('home halted');

    // When both lanes halt
    overflow.sessions[0]?.params.onHalt?.(first);
    home.sessions[0]?.params.onHalt?.(second);

    // Then my handler hears only the first
    expect(halts).toEqual([first]);
  });

  it('As a consumer, I disconnect and every session I opened ends, once', () => {
    // Given sessions on home and on an overflow lane
    const home = createFakeLane({ id: 1 });
    const overflow = createFakeLane({ id: 2 });
    const router = createLaneRouter({
      sessionId: 'consumer-1',
      onMessage: () => {},
      home: home.lane,
      pickFollowLane: () => overflow.lane,
      getLaneSessionId: lane => `consumer-1@${String(lane.id)}`,
    });
    router.send(createFollow(1));

    // When I disconnect twice
    router.disconnect();
    router.disconnect();

    // Then each session ended once
    expect([...home.sessions, ...overflow.sessions].map(s => s.disconnects)).toEqual([1, 1]);
  });

  it('As a consumer whose home session fails to end, I disconnect, hear that failure, and my session on another lane still ends', () => {
    // Given sessions on a home lane whose close fails and on an overflow lane
    const failure = new Error('home lane close failed');
    const home = createFakeLane({ id: 1, disconnectFailure: failure });
    const overflow = createFakeLane({ id: 2 });
    const router = createLaneRouter({
      sessionId: 'consumer-1',
      onMessage: () => {},
      home: home.lane,
      pickFollowLane: () => overflow.lane,
      getLaneSessionId: lane => `consumer-1@${String(lane.id)}`,
    });
    router.send(createFollow(1));

    // When I disconnect
    let thrown: unknown = null;
    try {
      router.disconnect();
    } catch (error) {
      thrown = error;
    }

    // Then I hear home's failure, and the overflow session ended too
    expect(thrown).toBe(failure);
    expect(overflow.sessions.map(s => s.disconnects)).toEqual([1]);
  });
});
