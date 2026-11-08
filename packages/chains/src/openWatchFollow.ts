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
  /** Hears the number of each new best block. */
  onBestBlock: (blockNumber: number) => void;
  /** Whether a follow the chain stopped is started again. False once the chain closed. */
  live: () => boolean;
};

type SendParams = {
  method: string;
  params: unknown[];
  /** Hears the request's id before the request goes out. */
  noteId?: (id: string) => void;
};

/** Opens a session through `connect`, sends the follow on `start`, and follows until `disconnect` ends the session. */
export function openWatchFollow({ sessionId, connect, onFollowing, onBestBlock, live }: Params): {
  start: () => void;
  disconnect: () => void;
} {
  let requests = 0;
  let followId: string | null = null;
  let token: string | null = null;
  // Still pinned, since it can be the best block.
  let finalized: string | null = null;
  const headerIds = new Set<string>();
  let closed = false;

  // The broker can answer inside `send`, so callers note the id first.
  function send({ method, params, noteId }: SendParams): void {
    const id = `${sessionId}:${requests.toString(36)}`;
    requests += 1;
    noteId?.(id);
    session.send({ jsonrpc: '2.0', id, method, params });
  }
  function follow(): void {
    token = null;
    finalized = null;
    headerIds.clear();
    send({
      method: CHAIN_HEAD_FOLLOW,
      params: [true],
      noteId: id => {
        followId = id;
      },
    });
  }
  function unpin(hashes: string[]): void {
    if (token !== null && hashes.length > 0) {
      send({ method: CHAIN_HEAD_UNPIN, params: [token, hashes] });
    }
  }
  function handleEvent(result: Record<string, unknown>): void {
    if (result['event'] === 'initialized') {
      const hashes = readStrings(result['finalizedBlockHashes']);
      finalized = hashes.at(-1) ?? null;
      unpin(hashes.slice(0, -1));
    } else if (result['event'] === 'bestBlockChanged' && token !== null) {
      send({
        method: CHAIN_HEAD_HEADER,
        params: [token, result['bestBlockHash']],
        noteId: id => {
          headerIds.add(id);
        },
      });
    } else if (result['event'] === 'finalized') {
      const hashes = readStrings(result['finalizedBlockHashes']);
      unpin([
        ...(finalized === null ? [] : [finalized]),
        ...hashes.slice(0, -1),
        ...readStrings(result['prunedBlockHashes']),
      ]);
      finalized = hashes.at(-1) ?? finalized;
    } else if (result['event'] === 'stop') {
      token = null;
      onFollowing(false);
      // A halted chain stops it too, and its broker has dropped this session by then.
      if (!closed && live()) {
        follow();
      }
    }
  }
  const session = connect(message => {
    if (!isRecord(message)) {
      return;
    }
    const id = message['id'];
    const result = message['result'];
    if (id === followId) {
      if (typeof result === 'string') {
        token = result;
        onFollowing(true);
      } else {
        log.debug(`[dot.li chain-pool] ${sessionId} refused the network panel's follow`, message['error']);
      }
    } else if (typeof id === 'string' && headerIds.delete(id)) {
      // Refused for a block finalization already unpinned, and the next best block reports instead.
      const blockNumber = typeof result === 'string' ? decodeHeaderNumber(result) : null;
      if (blockNumber !== null) {
        onBestBlock(blockNumber);
      }
    } else if (message['method'] === CHAIN_HEAD_FOLLOW_EVENT) {
      const params = message['params'];
      if (isRecord(params) && params['subscription'] === token && isRecord(params['result'])) {
        handleEvent(params['result']);
      }
    }
  });
  return {
    /** Sends the follow. Called once, after the caller stored the follow. Throws what the session's send throws. */
    start() {
      follow();
    },
    /** Ends the session and stops a follow the chain stops from starting again. */
    disconnect() {
      closed = true;
      session.disconnect();
    },
  };
}
