// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One consumer's connection to a chain that holds several lanes. Requests go to the consumer's home lane, a follow goes
// to the lane picked for it, and a call on a follow's token goes to the lane that holds it.

import { getErrorMessage, runEvery } from '@dotli/shared';
import {
  DEFAULT_WIRE_MODE,
  encodeForWire,
  isRequestMessage,
  parseInboundMessage,
  type BrokerConnection,
  type JsonRpcRequest,
} from './brokerMessages.js';
import type { ChainBroker } from './createChainBroker.js';
import { createJsonRpcError } from './createJsonRpcError.js';
import { CHAIN_HEAD_FOLLOW } from './jsonRpcMethods.js';

/** What a lane's `connect` takes: the broker's own session params. */
export type LaneConnectParams = Parameters<ChainBroker['connect']>[0];

/** One lane as a consumer's router reaches it. */
export type LaneHandle = {
  /** Unique within its chain for the chain's life. */
  readonly id: number;
  /** Whether a session on this lane holds `localToken`. Never throws. */
  hasToken(localToken: string): boolean;
  /** Opens a session on this lane. Throws when `sessionId` names an open session of the lane. */
  connect(params: LaneConnectParams): BrokerConnection;
};

type Params = LaneConnectParams & {
  /** The consumer's home lane. */
  home: LaneHandle;
  /**
   * The lane for a follow the consumer sends now: home while it has room, else another. Null once the chain halted or
   * when no lane with room can be built. Never throws.
   */
  pickFollowLane: () => LaneHandle | null;
  /** The consumer's session id on a lane other than home, unique among every session of the chain. */
  getLaneSessionId: (lane: LaneHandle) => string;
};

type LaneSession = {
  lane: LaneHandle;
  connection: BrokerConnection;
};

/**
 * Opens the consumer's session on `home` and routes what it sends across the chain's lanes. Throws what `home.connect`
 * throws. The connection's `send` never throws, and its `disconnect` ends every session it opened, once, even past one
 * that throws, then throws what they threw.
 */
export function createLaneRouter({
  home,
  pickFollowLane,
  getLaneSessionId,
  sessionId,
  onMessage,
  wireMode = DEFAULT_WIRE_MODE,
  onHalt = null,
}: Params): BrokerConnection {
  let haltHeard = false;
  let disconnected = false;
  const homeConnection = home.connect({ sessionId, onMessage, wireMode, onHalt: handleHalt });
  // The sessions on lanes other than home, by lane id, kept until `disconnect`.
  const laneSessions = new Map<number, LaneSession>();

  function send(message: unknown): void {
    const request = readRequest(message);
    // Home's broker answers or reports a message that is not one request, and drops one sent after `disconnect`.
    if (request === null || disconnected) {
      homeConnection.send(message);
      return;
    }
    if (request.method === CHAIN_HEAD_FOLLOW) {
      sendFollow(request);
      return;
    }
    const tokenLane = findTokenLane(request);
    (tokenLane ?? homeConnection).send(request);
  }

  function sendFollow(request: JsonRpcRequest): void {
    const lane = pickFollowLane();
    if (lane === null) {
      answerUnsent(request, `No lane can take a follow of ${sessionId}`);
      return;
    }
    if (lane.id === home.id) {
      homeConnection.send(request);
      return;
    }
    try {
      openLaneSession(lane).send(request);
    } catch (error) {
      answerUnsent(request, getErrorMessage(error));
    }
  }

  function openLaneSession(lane: LaneHandle): BrokerConnection {
    const open = laneSessions.get(lane.id);
    if (open) {
      return open.connection;
    }
    const connection = lane.connect({ sessionId: getLaneSessionId(lane), onMessage, wireMode, onHalt: handleHalt });
    laneSessions.set(lane.id, { lane, connection });
    return connection;
  }

  function findTokenLane(request: JsonRpcRequest): BrokerConnection | null {
    const localToken: unknown = Array.isArray(request.params) ? request.params[0] : undefined;
    if (typeof localToken !== 'string') {
      return null;
    }
    for (const { lane, connection } of laneSessions.values()) {
      if (lane.hasToken(localToken)) {
        return connection;
      }
    }
    return null;
  }

  function answerUnsent(request: JsonRpcRequest, message: string): void {
    onMessage(encodeForWire(createJsonRpcError(request.id ?? null, message), wireMode));
  }

  function handleHalt(error?: unknown): void {
    if (haltHeard) {
      return;
    }
    haltHeard = true;
    onHalt?.(error);
  }

  function disconnect(): void {
    if (disconnected) {
      return;
    }
    disconnected = true;
    try {
      runEvery(
        [
          () => {
            homeConnection.disconnect();
          },
          ...[...laneSessions.values()].map(({ connection }) => () => {
            connection.disconnect();
          }),
        ],
        `Lane router of ${sessionId}: ending every session failed`,
      );
    } finally {
      laneSessions.clear();
    }
  }

  return { send, disconnect };
}

/** The one request `message` holds, parsed, or null for anything else, such as text that does not parse or a batch. */
function readRequest(message: unknown): JsonRpcRequest | null {
  try {
    const parsed = parseInboundMessage(message);
    return isRequestMessage(parsed) ? parsed : null;
  } catch {
    // The caller sends what does not parse to home as it came, whose broker reports it.
    return null;
  }
}
