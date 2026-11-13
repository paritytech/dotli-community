// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The network panel's own chainHead follow on a chain someone holds, so its blocks keep coming while no consumer
// follows it. It is a follow of its own, beside any consumer's, with the runtime as polkadot-api asks. Each best
// block is numbered from its header, and a block stays pinned until finalization passes it.

import { isRecord, log } from '@dotli/shared';
import type { BrokerConnection } from './brokerMessages.js';
import { decodeHeaderNumber } from './decodeHeaderNumber.js';
import { CHAIN_HEAD_FOLLOW, CHAIN_HEAD_FOLLOW_EVENT, CHAIN_HEAD_HEADER, CHAIN_HEAD_UNPIN } from './jsonRpcMethods.js';
import { readStrings } from './readStrings.js';

type Params = {
  /** Prefix of the follow's request ids. Also names it in debug logs. */
  sessionId: string;
  /** Opens the follow's session. Messages may arrive inside `send`, before it returns. */
  connect: (onMessage: (message: unknown) => void) => BrokerConnection;
  /** The follow was established, or stopped. */
  onFollowing: (following: boolean) => void;
  /** The node refused the follow, which then sends nothing more. */
  onRefused: () => void;
  /** Hears the number of each new best block. */
  onBestBlock: (blockNumber: number) => void;
};

type FollowState =
  | { kind: 'idle' }
  | { kind: 'requesting'; id: string }
  | {
      kind: 'following';
      token: string;
      /** Still pinned, since it can be the best block. */
      finalized: string | null;
      headerIds: Set<string>;
    }
  | { kind: 'stopped' }
  | { kind: 'refused' }
  | { kind: 'closed' };

type Following = Extract<FollowState, { kind: 'following' }>;

/**
 * Opens a session through `connect`, sends the follow on `start`, and follows until `disconnect` ends the session. A
 * follow the chain stops is sent again.
 */
export function openWatchFollow({ sessionId, connect, onFollowing, onRefused, onBestBlock }: Params) {
  let requests = 0;
  let state: FollowState = { kind: 'idle' };

  // The broker can answer inside `send`, so a caller stores the id before it sends.
  function takeId(): string {
    const id = `${sessionId}:${requests.toString(36)}`;
    requests += 1;
    return id;
  }
  function send(id: string, method: string, params: unknown[]): void {
    session.send({ jsonrpc: '2.0', id, method, params });
  }
  function follow(): void {
    const id = takeId();
    state = { kind: 'requesting', id };
    send(id, CHAIN_HEAD_FOLLOW, [true]);
  }
  function unpin(following: Following, hashes: string[]): void {
    if (hashes.length > 0) {
      send(takeId(), CHAIN_HEAD_UNPIN, [following.token, hashes]);
    }
  }
  function handleMessage(message: Record<string, unknown>): void {
    switch (state.kind) {
      case 'requesting':
        handleFollowAnswer(state, message);
        return;
      case 'following':
        handleFollowingMessage(state, message);
        return;
      case 'idle':
      case 'stopped':
      case 'refused':
      case 'closed':
        return;
    }
  }
  function handleFollowAnswer(
    requesting: Extract<FollowState, { kind: 'requesting' }>,
    message: Record<string, unknown>,
  ): void {
    if (message['id'] !== requesting.id) {
      return;
    }
    const result = message['result'];
    if (typeof result === 'string') {
      state = { kind: 'following', token: result, finalized: null, headerIds: new Set() };
      onFollowing(true);
    } else {
      state = { kind: 'refused' };
      log.debug(`[dot.li chain-pool] ${sessionId} refused the network panel's follow`, message['error']);
      onRefused();
    }
  }
  function handleFollowingMessage(following: Following, message: Record<string, unknown>): void {
    const id = message['id'];
    if (typeof id === 'string' && following.headerIds.delete(id)) {
      // Refused for a block finalization already unpinned, and the next best block reports instead.
      const result = message['result'];
      const blockNumber = typeof result === 'string' ? decodeHeaderNumber(result) : null;
      if (blockNumber !== null) {
        onBestBlock(blockNumber);
      }
    } else if (message['method'] === CHAIN_HEAD_FOLLOW_EVENT) {
      const params = message['params'];
      if (isRecord(params) && params['subscription'] === following.token && isRecord(params['result'])) {
        handleEvent(following, params['result']);
      }
    }
  }
  function handleEvent(following: Following, result: Record<string, unknown>): void {
    if (result['event'] === 'initialized') {
      const hashes = readStrings(result['finalizedBlockHashes']);
      following.finalized = hashes.at(-1) ?? null;
      unpin(following, hashes.slice(0, -1));
    } else if (result['event'] === 'bestBlockChanged') {
      const id = takeId();
      following.headerIds.add(id);
      send(id, CHAIN_HEAD_HEADER, [following.token, result['bestBlockHash']]);
    } else if (result['event'] === 'finalized') {
      const hashes = readStrings(result['finalizedBlockHashes']);
      unpin(following, [
        ...(following.finalized === null ? [] : [following.finalized]),
        ...hashes.slice(0, -1),
        ...readStrings(result['prunedBlockHashes']),
      ]);
      following.finalized = hashes.at(-1) ?? following.finalized;
    } else if (result['event'] === 'stop') {
      const stopped: FollowState = { kind: 'stopped' };
      state = stopped;
      onFollowing(false);
      // The owner ends a follow by disconnecting it, which may happen while it hears the stop.
      if (state === stopped) {
        follow();
      }
    }
  }
  const session = connect(message => {
    if (isRecord(message)) {
      handleMessage(message);
    }
  });
  return {
    /**
     * Sends the follow once, after the caller stored the follow, since no callback runs before it. Throws what the
     * session's send throws.
     */
    start() {
      if (state.kind === 'idle') {
        follow();
      }
    },
    /** Ends the session and stops a follow the chain stops from starting again. Repeating it does nothing. */
    disconnect() {
      if (state.kind === 'closed') {
        return;
      }
      state = { kind: 'closed' };
      session.disconnect();
    },
  };
}
