// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The network panel's own chainHead follow on a chain someone holds, so its blocks keep coming while no consumer
// follows it. It is a follow of its own, beside any consumer's, with the runtime as polkadot-api asks. Each best
// block is numbered from its header, and a block stays pinned until finalization passes it.

import { isRecord, log } from '@dotli/shared';
import { decodeHeaderNumber } from './decodeHeaderNumber.js';
import { CHAIN_HEAD_FOLLOW, CHAIN_HEAD_FOLLOW_EVENT, CHAIN_HEAD_HEADER, CHAIN_HEAD_UNPIN } from './jsonRpcMethods.js';
import { readStrings } from './readStrings.js';

/** A broker session as the follow uses it. */
export type FollowSession = {
  /** Sends one JSON-RPC request. The answer may arrive before it returns. */
  send: (message: unknown) => void;
  /** Ends the session. */
  disconnect: () => void;
};

type Params = {
  /** Prefix of the follow's request ids. Also names it in debug logs. */
  sessionId: string;
  /** Opens the follow's session. Messages may arrive inside `send`, before it returns. */
  connect: (onMessage: (message: unknown) => void) => FollowSession;
  /** The follow was established, or stopped. */
  onFollowing: (following: boolean) => void;
  /** The node refused the follow, which then sends nothing more. */
  onRefused: () => void;
  /** Hears the number of each new best block. */
  onBestBlock: (blockNumber: number) => void;
  /** Whether a follow the chain stopped is started again. False once the chain closed. */
  live: () => boolean;
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

type SendParams = {
  method: string;
  params: unknown[];
  /** Hears the request's id before the request goes out. */
  noteId?: (id: string) => void;
};

/** Opens a session through `connect`, sends the follow on `start`, and follows until `disconnect` ends the session. */
export function openWatchFollow({ sessionId, connect, onFollowing, onRefused, onBestBlock, live }: Params): {
  start: () => void;
  disconnect: () => void;
} {
  let requests = 0;
  let state: FollowState = { kind: 'idle' };

  // The broker can answer inside `send`, so callers note the id first.
  function send({ method, params, noteId }: SendParams): void {
    const id = `${sessionId}:${requests.toString(36)}`;
    requests += 1;
    noteId?.(id);
    session.send({ jsonrpc: '2.0', id, method, params });
  }
  function follow(): void {
    send({
      method: CHAIN_HEAD_FOLLOW,
      params: [true],
      noteId: id => {
        state = { kind: 'requesting', id };
      },
    });
  }
  function unpin(following: Following, hashes: string[]): void {
    if (hashes.length > 0) {
      send({ method: CHAIN_HEAD_UNPIN, params: [following.token, hashes] });
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
      send({
        method: CHAIN_HEAD_HEADER,
        params: [following.token, result['bestBlockHash']],
        noteId: id => {
          following.headerIds.add(id);
        },
      });
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
      // A halted chain stops it too, and its broker has dropped this session by then.
      if (state === stopped && live()) {
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
