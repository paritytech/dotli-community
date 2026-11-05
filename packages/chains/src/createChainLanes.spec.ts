// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import { spans as S } from '@dotli/metrics';
import { bindRecordingSentry, recordCaptures } from '@dotli/metrics/testing';
import { bindLogSink, isRecord } from '@dotli/shared';
import { catchError, must, nth } from '@dotli/shared/testing';
import type {
  JsonRpcConnection,
  JsonRpcMessage,
  JsonRpcProvider,
  JsonRpcRequest,
} from '@polkadot-api/json-rpc-provider';
import type { BrokerConnection } from './brokerMessages.js';
import { createChainLanes, type ChainLanes } from './createChainLanes.js';
import { CHAIN_HEAD_FOLLOW, CHAIN_HEAD_UNFOLLOW, SUBMIT_AND_WATCH, WATCH_EVENT } from './jsonRpcMethods.js';
import {
  RPC_FOLLOW_LIMIT,
  type ChainTransport,
  type ChainTransportHooks,
  type ConnectionStatus,
} from './transportHooks.js';

/** What goes wrong with one transport: none built, its build throws, its opening throws, or its close throws. */
type TransportFault = 'null' | 'build' | 'open' | 'disconnect';

type TransportRecord = {
  hooks: ChainTransportHooks;
  /** What the lane sent the node, in order. */
  sent: JsonRpcRequest[];
  /** Delivers a message from the node. */
  emit: (message: JsonRpcMessage) => void;
  opened: number;
  disconnects: number;
};

type TransportsParams = {
  followLimit?: number;
  /** The fault of each transport the factory is asked for, by call from 0. */
  faults?: Partial<Record<number, TransportFault>>;
};

type LanesParams = {
  createTransport: (hooks: ChainTransportHooks) => ChainTransport | null;
  paused?: boolean;
  /** Whether the chain's halt handler halts the lanes, as the pool's does. Yes by default. */
  haltsLanes?: boolean;
};

type Consumer = {
  connection: BrokerConnection;
  heard: unknown[];
  halts: unknown[];
};

const LABEL = 'test-chain';
const FAULT = new Error('transport fault');

/** A transport factory that records what each lane's connection sends, and lets a test answer as the node. */
function createTransports({ followLimit = RPC_FOLLOW_LIMIT, faults = {} }: TransportsParams = {}): {
  createTransport: (hooks: ChainTransportHooks) => ChainTransport | null;
  built: TransportRecord[];
} {
  const built: TransportRecord[] = [];
  let calls = 0;
  function createTransport(hooks: ChainTransportHooks): ChainTransport | null {
    const fault = faults[calls];
    calls += 1;
    if (fault === 'null') {
      return null;
    }
    if (fault === 'build') {
      throw FAULT;
    }
    let listener: ((message: JsonRpcMessage) => void) | null = null;
    const record: TransportRecord = {
      hooks,
      sent: [],
      emit(message) {
        listener?.(message);
      },
      opened: 0,
      disconnects: 0,
    };
    built.push(record);
    const provider: JsonRpcProvider = (onMessage): JsonRpcConnection => {
      if (fault === 'open') {
        throw FAULT;
      }
      listener = onMessage;
      record.opened += 1;
      return {
        send(message) {
          record.sent.push(message);
        },
        disconnect() {
          record.disconnects += 1;
          if (fault === 'disconnect') {
            throw FAULT;
          }
        },
      };
    };
    return { provider, followLimit };
  }
  return { createTransport, built };
}

/** Builds a chain's lanes that record each combined status and halt, and halt themselves on a halt as the pool does. */
function createLanes({ createTransport, paused = false, haltsLanes = true }: LanesParams): {
  lanes: ChainLanes;
  statuses: ConnectionStatus[];
  halts: unknown[];
} {
  const statuses: ConnectionStatus[] = [];
  const halts: unknown[] = [];
  let built: ChainLanes | null = null;
  const lanes = must(
    createChainLanes({
      label: LABEL,
      createTransport,
      warn: () => {},
      paused,
      onStatus: status => {
        statuses.push(status);
      },
      onHalt: error => {
        halts.push(error);
        if (haltsLanes) {
          built?.halt(error);
        }
      },
    }),
    'lane 0',
  );
  built = lanes;
  return { lanes, statuses, halts };
}

function connectConsumer(lanes: ChainLanes, sessionId: string): Consumer {
  const heard: unknown[] = [];
  const halts: unknown[] = [];
  const connection = lanes.connect({
    sessionId,
    wireMode: 'object',
    onMessage: message => {
      heard.push(message);
    },
    onHalt: error => {
      halts.push(error);
    },
  });
  return { connection, heard, halts };
}

/** Connects `local:a` to `local:d`, and each follows once, so lane 0 holds as many follows as an RPC node takes. */
function fillLaneZero(lanes: ChainLanes): Consumer[] {
  const consumers = ['a', 'b', 'c', 'd'].map(name => connectConsumer(lanes, `local:${name}`));
  for (const consumer of consumers) {
    consumer.connection.send(createFollow(1));
  }
  return consumers;
}

function createFollow(id: number): JsonRpcRequest {
  return { jsonrpc: '2.0', id, method: CHAIN_HEAD_FOLLOW, params: [true] };
}

function listSent(record: TransportRecord, method: string): JsonRpcRequest[] {
  return record.sent.filter(message => message.method === method);
}

/** Answers, as the node, every request of `method` the lane sent, the n-th with `<method>-<n>`. */
function answerAll(record: TransportRecord, method: string): void {
  for (const [index, request] of listSent(record, method).entries()) {
    record.emit({ jsonrpc: '2.0', id: must(request.id, 'a request id'), result: `${method}-${String(index)}` });
  }
}

/** The answer the consumer heard to its request `id`. */
function readAnswer(consumer: Consumer, id: number): Record<string, unknown> {
  const answer = consumer.heard.find(message => isRecord(message) && message['id'] === id);
  return must(isRecord(answer) ? answer : undefined, `the answer to ${String(id)}`);
}

function listWatchEvents(consumer: Consumer): unknown[] {
  return consumer.heard.filter(message => isRecord(message) && message['method'] === WATCH_EVENT);
}

describe('createChainLanes', () => {
  it('As a chain with no follow limit, I put every consumer and follow on one lane', () => {
    // Given lanes over a transport with no follow limit, and five consumers
    const { createTransport, built } = createTransports({ followLimit: Infinity });
    const { lanes } = createLanes({ createTransport });
    const consumers = ['a', 'b', 'c', 'd', 'e'].map(name => connectConsumer(lanes, `local:${name}`));

    // When each follows
    for (const consumer of consumers) {
      consumer.connection.send(createFollow(1));
    }

    // Then one lane is built and it sends all five follows
    expect(built).toHaveLength(1);
    expect(listSent(nth(built, 0), CHAIN_HEAD_FOLLOW)).toHaveLength(5);
  });

  it('As an RPC chain, I open a second lane for the fifth follow and send it there', () => {
    // Given lanes over an RPC transport, and five consumers
    const { createTransport, built } = createTransports();
    const { lanes } = createLanes({ createTransport });
    const consumers = ['a', 'b', 'c', 'd', 'e'].map(name => connectConsumer(lanes, `local:${name}`));

    // When each follows
    for (const consumer of consumers) {
      consumer.connection.send(createFollow(1));
    }

    // Then four follows go out on lane 0 and the fifth on a second lane
    expect(built).toHaveLength(2);
    expect(listSent(nth(built, 0), CHAIN_HEAD_FOLLOW)).toHaveLength(4);
    expect(listSent(nth(built, 1), CHAIN_HEAD_FOLLOW)).toHaveLength(1);
  });

  it('As an RPC chain, I send two follows together into a lane with one slot left and only the first takes it', () => {
    // Given lane 0 with three follows, and a fourth consumer
    const { createTransport, built } = createTransports();
    const { lanes } = createLanes({ createTransport });
    for (const name of ['a', 'b', 'c']) {
      connectConsumer(lanes, `local:${name}`).connection.send(createFollow(1));
    }
    const consumer = connectConsumer(lanes, 'local:d');

    // When the fourth consumer sends two follows back to back
    consumer.connection.send(createFollow(1));
    consumer.connection.send(createFollow(2));

    // Then the first takes lane 0's last slot and the second goes out on a new lane
    expect(listSent(nth(built, 0), CHAIN_HEAD_FOLLOW)).toHaveLength(4);
    expect(listSent(nth(built, 1), CHAIN_HEAD_FOLLOW)).toHaveLength(1);
  });

  it('As an RPC chain, I count an unfollow in flight, so a consumer that follows again at once goes to another lane', () => {
    // Given lane 0 full of answered follows
    const { createTransport, built } = createTransports();
    const { lanes } = createLanes({ createTransport });
    const [first] = fillLaneZero(lanes);
    const consumer = must(first, 'the first consumer');
    answerAll(nth(built, 0), CHAIN_HEAD_FOLLOW);
    const token = readAnswer(consumer, 1)['result'];

    // When one consumer unfollows and, before the node answers, follows again
    consumer.connection.send({ jsonrpc: '2.0', id: 2, method: CHAIN_HEAD_UNFOLLOW, params: [token] });
    consumer.connection.send(createFollow(3));

    // Then the unfollow goes out on lane 0 and the new follow on a new lane
    expect(listSent(nth(built, 0), CHAIN_HEAD_UNFOLLOW)).toHaveLength(1);
    expect(listSent(nth(built, 0), CHAIN_HEAD_FOLLOW)).toHaveLength(4);
    expect(listSent(nth(built, 1), CHAIN_HEAD_FOLLOW)).toHaveLength(1);
  });

  it('As an RPC chain, I give a new consumer the lane with room and the fewest consumers at home', () => {
    // Given lane 0 full, a consumer homed on lane 1 as it opened, and then a consumer of lane 0 gone with its unfollow
    // answered, so lane 0 has room for one follow and three consumers at home
    const { createTransport, built } = createTransports();
    const { lanes } = createLanes({ createTransport });
    const [first] = fillLaneZero(lanes);
    answerAll(nth(built, 0), CHAIN_HEAD_FOLLOW);
    connectConsumer(lanes, 'local:e');
    must(first, 'the first consumer').connection.disconnect();
    answerAll(nth(built, 0), CHAIN_HEAD_UNFOLLOW);

    // When a new consumer connects and asks for the genesis hash
    const consumer = connectConsumer(lanes, 'local:f');
    consumer.connection.send({ jsonrpc: '2.0', id: 1, method: 'chainSpec_v1_genesisHash', params: [] });

    // Then the request goes out on lane 1, which has room and one consumer at home
    expect(nth(built, 1).sent.map(message => message.method)).toEqual(['chainSpec_v1_genesisHash']);
  });

  it('As an RPC chain, I send a consumer homed on a lane with room its follow there before a lower lane with room', () => {
    // Given lane 0 full, a consumer homed on lane 1, and then lane 0 with one slot free
    const { createTransport, built } = createTransports();
    const { lanes } = createLanes({ createTransport });
    const [first] = fillLaneZero(lanes);
    answerAll(nth(built, 0), CHAIN_HEAD_FOLLOW);
    const extra = connectConsumer(lanes, 'local:e');
    must(first, 'the first consumer').connection.disconnect();
    answerAll(nth(built, 0), CHAIN_HEAD_UNFOLLOW);

    // When the consumer homed on lane 1 follows
    extra.connection.send(createFollow(1));

    // Then the follow goes out on lane 1, and lane 0 keeps its free slot
    expect(listSent(nth(built, 1), CHAIN_HEAD_FOLLOW)).toHaveLength(1);
    expect(listSent(nth(built, 0), CHAIN_HEAD_FOLLOW)).toHaveLength(4);
  });

  it('As an RPC chain, I close an extra lane when its last consumer leaves, and keep lane 0', () => {
    // Given lane 0 full, and a consumer homed on lane 1
    const { createTransport, built } = createTransports();
    const { lanes } = createLanes({ createTransport });
    const consumers = fillLaneZero(lanes);
    const extra = connectConsumer(lanes, 'local:e');

    // When every consumer leaves
    extra.connection.disconnect();
    for (const consumer of consumers) {
      consumer.connection.disconnect();
    }

    // Then lane 1's connection is closed and lane 0's stays open
    expect(nth(built, 1).disconnects).toBe(1);
    expect(nth(built, 0).disconnects).toBe(0);
  });

  it('As an RPC chain, I never give a new lane the id of a closed one', () => {
    // Given lane 0 full of answered follows, and lane 1 opened and closed again
    const { createTransport, built } = createTransports();
    const { lanes } = createLanes({ createTransport });
    const [first] = fillLaneZero(lanes);
    const consumer = must(first, 'the first consumer');
    answerAll(nth(built, 0), CHAIN_HEAD_FOLLOW);
    connectConsumer(lanes, 'local:e').connection.disconnect();

    // When a consumer follows again, and the node answers on the lane opened for it
    consumer.connection.send(createFollow(2));
    answerAll(nth(built, 2), CHAIN_HEAD_FOLLOW);

    // Then the follow's token names lane 2
    expect(readAnswer(consumer, 2)['result']).toEqual(expect.stringContaining(':lane:2:'));
  });

  it('As an RPC chain, I read connecting while a new lane opens, and connected once every lane is', () => {
    // Given lane 0 connected and full
    const { createTransport, built } = createTransports();
    const { lanes, statuses } = createLanes({ createTransport });
    nth(built, 0).hooks.onStatus('connected');
    fillLaneZero(lanes);

    // When a consumer opens lane 1, and lane 1 connects
    connectConsumer(lanes, 'local:e');
    const opening = lanes.status();
    nth(built, 1).hooks.onStatus('connected');

    // Then the chain reads connecting while lane 1 opens, and connected after
    expect(opening).toBe('connecting');
    expect(statuses).toEqual(['connected', 'connecting', 'connected']);
    expect(lanes.status()).toBe('connected');
  });

  it('As an RPC chain, I ignore a status from a lane I closed', () => {
    // Given lane 0 connected and full, and lane 1 connected and then closed as its consumer left
    const { createTransport, built } = createTransports();
    const { lanes, statuses } = createLanes({ createTransport });
    nth(built, 0).hooks.onStatus('connected');
    fillLaneZero(lanes);
    const extra = connectConsumer(lanes, 'local:e');
    nth(built, 1).hooks.onStatus('connected');
    extra.connection.disconnect();

    // When the closed lane reports a disconnect
    nth(built, 1).hooks.onStatus('disconnected');

    // Then the chain stays connected
    expect(lanes.status()).toBe('connected');
    expect(statuses).toEqual(['connected', 'connecting', 'connected']);
  });

  it('As an RPC chain, I ignore a status from a lane once the chain halted, even before its lanes are halted', () => {
    // Given lane 0 whose chain halted, with a halt handler that has not yet halted the lanes
    const { createTransport, built } = createTransports();
    const { statuses } = createLanes({ createTransport, haltsLanes: false });
    nth(built, 0).hooks.onHalt(FAULT);

    // When lane 0 reports that it connected
    nth(built, 0).hooks.onStatus('connected');

    // Then no status change is reported
    expect(statuses).toEqual([]);
  });

  it("As an RPC chain, I halt every consumer when one lane's transport halts, with that halt's error", () => {
    // Given a consumer on lane 0 and one homed on lane 1
    const { createTransport, built } = createTransports();
    const { lanes, halts } = createLanes({ createTransport });
    const [first] = fillLaneZero(lanes);
    const extra = connectConsumer(lanes, 'local:e');

    // When lane 1's transport halts, and then lane 0's
    nth(built, 1).hooks.onHalt(FAULT);
    nth(built, 0).hooks.onHalt(new Error('a later halt'));

    // Then the chain halts once with the first error, and both consumers hear it
    expect(halts).toEqual([FAULT]);
    expect(must(first, 'the first consumer').halts).toEqual([FAULT]);
    expect(extra.halts).toEqual([FAULT]);
  });

  it("As an RPC chain, I report and halt when a new lane's transport cannot be built", () => {
    // Given lane 0 full, and no transport for a second lane
    const captured = recordCaptures({ onFinished: onTestFinished });
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    onTestFinished(bindLogSink({ emit: () => undefined }));
    const { createTransport } = createTransports({ faults: { 1: 'null' } });
    const { lanes, halts } = createLanes({ createTransport });
    const [first] = fillLaneZero(lanes);
    const consumer = must(first, 'the first consumer');

    // When a consumer follows again
    consumer.connection.send(createFollow(2));

    // Then the build is reported, the chain halts naming the lane, and the follow is answered with an error
    expect(captured).toEqual([{ flow: 'protocol', step: 'chain_lane_build' }]);
    expect(metrics.counted(S.CHAIN_LANE_OPEN)).toEqual([{ outcome: 'error', reason: 'Error' }]);
    expect(halts).toEqual([expect.objectContaining({ message: `${LABEL} lane 1 could not be built` })]);
    expect(readAnswer(consumer, 2)).toHaveProperty('error');
  });

  it('As an RPC chain, I report a follow whose session cannot open on a new lane, and answer it with an error', () => {
    // Given lane 0 full, and a second lane whose connection throws on opening
    const captured = recordCaptures({ onFinished: onTestFinished });
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    onTestFinished(bindLogSink({ emit: () => undefined }));
    const { createTransport } = createTransports({ faults: { 1: 'open' } });
    const { lanes, halts } = createLanes({ createTransport });
    const [first] = fillLaneZero(lanes);
    const consumer = must(first, 'the first consumer');

    // When a consumer follows again
    consumer.connection.send(createFollow(2));

    // Then the session's failure is reported, the follow is answered with an error, and the chain does not halt
    expect(captured).toEqual([{ flow: 'protocol', step: 'chain_lane_session' }]);
    expect(metrics.counted(S.CHAIN_LANE_OPEN)).toEqual([{ outcome: 'error', reason: 'Error' }]);
    expect(readAnswer(consumer, 2)).toHaveProperty('error');
    expect(halts).toEqual([]);
  });

  it("As an RPC chain, I pause every lane when one lane's pause throws, and throw its error", () => {
    // Given lane 0 whose close throws, and lane 1 open
    const { createTransport, built } = createTransports({ faults: { 0: 'disconnect' } });
    const { lanes, statuses } = createLanes({ createTransport });
    fillLaneZero(lanes);
    connectConsumer(lanes, 'local:e');

    // When the chain pauses
    const thrown = catchError(() => {
      lanes.pause();
    });

    // Then lane 1 is paused too, the chain reads paused and disconnected, the last status heard is disconnected, and lane 0's error is thrown
    expect(thrown).toBe(FAULT);
    expect(nth(built, 1).disconnects).toBe(1);
    expect(lanes.isPaused()).toBe(true);
    expect(lanes.status()).toBe('disconnected');
    expect(statuses.at(-1)).toBe('disconnected');
  });

  it("As an RPC chain, I halt every lane when one lane's halt throws, and throw its error", () => {
    // Given lane 0 whose close throws, and a consumer homed on lane 1
    const { createTransport, built } = createTransports({ faults: { 0: 'disconnect' } });
    const { lanes, statuses } = createLanes({ createTransport });
    fillLaneZero(lanes);
    const extra = connectConsumer(lanes, 'local:e');
    const error = new Error('halted');

    // When the chain halts
    const thrown = catchError(() => {
      lanes.halt(error);
    });

    // Then lane 1 halts too, the last status heard is disconnected, and lane 0's error is thrown
    expect(thrown).toBe(FAULT);
    expect(extra.halts).toEqual([error]);
    expect(nth(built, 1).disconnects).toBe(1);
    expect(statuses.at(-1)).toBe('disconnected');
  });

  it("As an RPC chain, I close every lane when one lane's close throws, and throw its error", () => {
    // Given lane 0 whose close throws, and lane 1 open
    const { createTransport, built } = createTransports({ faults: { 0: 'disconnect' } });
    const { lanes, statuses } = createLanes({ createTransport });
    fillLaneZero(lanes);
    connectConsumer(lanes, 'local:e');

    // When the chain closes
    const thrown = catchError(() => {
      lanes.disconnectAll();
    });

    // Then lane 1 closes too, the last status heard is disconnected, and lane 0's error is thrown
    expect(thrown).toBe(FAULT);
    expect(nth(built, 1).disconnects).toBe(1);
    expect(statuses.at(-1)).toBe('disconnected');
  });

  it('As an RPC chain, I report and halt when closing an empty extra lane throws', () => {
    // Given lane 0 full, and a consumer homed on lane 1, whose close throws
    const captured = recordCaptures({ onFinished: onTestFinished });
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    onTestFinished(bindLogSink({ emit: () => undefined }));
    const { createTransport } = createTransports({ faults: { 1: 'disconnect' } });
    const { lanes, halts } = createLanes({ createTransport });
    fillLaneZero(lanes);
    const extra = connectConsumer(lanes, 'local:e');

    // When that consumer leaves
    extra.connection.disconnect();

    // Then the close's failure is reported, and the chain halts with its error
    expect(captured).toEqual([{ flow: 'protocol', step: 'chain_lane_close' }]);
    expect(metrics.counted(S.CHAIN_POOL_CLOSE)).toEqual([{ outcome: 'error', reason: 'Error' }]);
    expect(halts).toEqual([FAULT]);
  });

  it("As an RPC chain, I halt when a new home lane cannot be built, and the consumer's connect throws", () => {
    // Given lane 0 full, and a second lane whose build throws
    const { createTransport } = createTransports({ faults: { 1: 'build' } });
    const { lanes, halts } = createLanes({ createTransport });
    fillLaneZero(lanes);

    // When a new consumer connects
    const thrown = catchError(() => connectConsumer(lanes, 'local:e'));

    // Then the connect throws the error that halted the chain, naming the lane, with the build's error as its cause
    expect(thrown).toEqual(expect.objectContaining({ message: `${LABEL} lane 1 could not be built`, cause: FAULT }));
    expect(halts).toEqual([thrown]);
  });

  it('As an RPC chain, I drop a new lane whose first session cannot open', () => {
    // Given lane 0 connected and full, and a second lane whose connection throws on opening
    const { createTransport, built } = createTransports({ faults: { 1: 'open' } });
    const { lanes, statuses, halts } = createLanes({ createTransport });
    nth(built, 0).hooks.onStatus('connected');
    fillLaneZero(lanes);

    // When a new consumer connects
    const thrown = catchError(() => connectConsumer(lanes, 'local:e'));

    // Then the connect throws the opening's error, the chain reads connected again and does not halt
    expect(thrown).toBe(FAULT);
    expect(statuses).toEqual(['connected', 'connecting', 'connected']);
    expect(halts).toEqual([]);
  });

  it('As a paused chain, I build a new lane closed and open it on resume', () => {
    // Given paused lanes with lane 0 full, and a follow that opened lane 1
    const { createTransport, built } = createTransports();
    const { lanes } = createLanes({ createTransport, paused: true });
    const [first] = fillLaneZero(lanes);
    must(first, 'the first consumer').connection.send(createFollow(2));
    const openedWhilePaused = nth(built, 1).opened;
    const statusWhilePaused = lanes.status();

    // When the chain resumes
    lanes.resume();

    // Then lane 1 was closed and disconnected while paused, and opens and sends its follow on resume
    expect(openedWhilePaused).toBe(0);
    expect(statusWhilePaused).toBe('disconnected');
    expect(nth(built, 1).opened).toBe(1);
    expect(listSent(nth(built, 1), CHAIN_HEAD_FOLLOW)).toHaveLength(1);
    expect(listSent(nth(built, 0), CHAIN_HEAD_FOLLOW)).toHaveLength(4);
  });

  it('As an RPC chain, I end the transaction watches only on the lane that disconnected', () => {
    // Given lane 0 full, a consumer homed on lane 1, and an answered transaction watch on each lane
    const { createTransport, built } = createTransports();
    const { lanes } = createLanes({ createTransport });
    const [first] = fillLaneZero(lanes);
    const consumer = must(first, 'the first consumer');
    const extra = connectConsumer(lanes, 'local:e');
    for (const watcher of [consumer, extra]) {
      watcher.connection.send({ jsonrpc: '2.0', id: 5, method: SUBMIT_AND_WATCH, params: ['0x00'] });
    }
    answerAll(nth(built, 0), SUBMIT_AND_WATCH);
    answerAll(nth(built, 1), SUBMIT_AND_WATCH);

    // When lane 1 disconnects
    nth(built, 1).hooks.onStatus('disconnected');

    // Then only the watch on lane 1 hears it dropped
    expect(listWatchEvents(extra)).toEqual([
      {
        jsonrpc: '2.0',
        method: WATCH_EVENT,
        params: { subscription: readAnswer(extra, 5)['result'], result: { event: 'dropped' } },
      },
    ]);
    expect(listWatchEvents(consumer)).toEqual([]);
  });
});
