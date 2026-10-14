// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The network panel's own chainHead follow on a chain someone holds, so its blocks keep coming while no consumer
// follows it. With the runtime, as polkadot-api asks, so a consumer's follow shares it upstream. Each best block is
// numbered from its header, and a block stays pinned until finalization passes it.

import { log } from '@dotli/shared';
import { decodeHeaderNumber } from './header-number.js';

/** A broker session as the follow uses it. */
export interface FollowSession {
  send: (message: unknown) => void;
  disconnect: () => void;
}

export interface WatchFollowOptions {
  /** Prefix of the follow's request ids. Also names it in debug logs. */
  sessionId: string;
  /** Opens the follow's session. Messages may arrive inside `send`, before it returns. */
  connect: (onMessage: (message: unknown) => void) => FollowSession;
  /** The follow was established, or stopped. */
  onFollowing: (following: boolean) => void;
  onBestBlock: (blockNumber: number) => void;
  /** Whether a follow the chain stopped is started again. False once the chain closed. */
  live: () => boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function openWatchFollow(options: WatchFollowOptions): { disconnect: () => void } {
  const { sessionId } = options;
  let requests = 0;
  let followId: string | null = null;
  let token: string | null = null;
  // Still pinned, since it can be the best block.
  let finalized: string | null = null;
  const headerIds = new Set<string>();
  let closed = false;

  // The broker can answer inside `send`, when it shares a follow already established, so callers note the id first.
  const send = (method: string, params: unknown[], noteId?: (id: string) => void): void => {
    const id = `${sessionId}:${requests.toString(36)}`;
    requests += 1;
    noteId?.(id);
    session.send({ jsonrpc: '2.0', id, method, params });
  };
  const follow = (): void => {
    token = null;
    finalized = null;
    headerIds.clear();
    send('chainHead_v1_follow', [true], id => {
      followId = id;
    });
  };
  const unpin = (hashes: string[]): void => {
    if (token !== null && hashes.length > 0) {
      send('chainHead_v1_unpin', [token, hashes]);
    }
  };
  const onEvent = (result: Record<string, unknown>): void => {
    if (result['event'] === 'initialized') {
      const hashes = stringsOf(result['finalizedBlockHashes']);
      finalized = hashes.at(-1) ?? null;
      unpin(hashes.slice(0, -1));
    } else if (result['event'] === 'bestBlockChanged' && token !== null) {
      send('chainHead_v1_header', [token, result['bestBlockHash']], id => {
        headerIds.add(id);
      });
    } else if (result['event'] === 'finalized') {
      const hashes = stringsOf(result['finalizedBlockHashes']);
      unpin([
        ...(finalized === null ? [] : [finalized]),
        ...hashes.slice(0, -1),
        ...stringsOf(result['prunedBlockHashes']),
      ]);
      finalized = hashes.at(-1) ?? finalized;
    } else if (result['event'] === 'stop') {
      token = null;
      options.onFollowing(false);
      // A halted chain stops it too, and its broker has dropped this session by then.
      if (!closed && options.live()) {
        follow();
      }
    }
  };
  const session = options.connect(message => {
    if (!isRecord(message)) {
      return;
    }
    const id = message['id'];
    const result = message['result'];
    if (id === followId) {
      if (typeof result === 'string') {
        token = result;
        options.onFollowing(true);
      } else {
        log.debug(`[dot.li chain-pool] ${sessionId} refused the network panel's follow`, message['error']);
      }
    } else if (typeof id === 'string' && headerIds.delete(id)) {
      // Refused for a block finalization already unpinned, and the next best block reports instead.
      const blockNumber = typeof result === 'string' ? decodeHeaderNumber(result) : null;
      if (blockNumber !== null) {
        options.onBestBlock(blockNumber);
      }
    } else if (message['method'] === 'chainHead_v1_followEvent') {
      const params = message['params'];
      if (isRecord(params) && params['subscription'] === token && isRecord(params['result'])) {
        onEvent(params['result']);
      }
    }
  });
  follow();
  return {
    disconnect: () => {
      closed = true;
      session.disconnect();
    },
  };
}
