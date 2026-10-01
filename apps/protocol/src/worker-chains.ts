// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The SharedWorker's remote chain connections: one pool lease each, tied to
// the port and the origin that opened it. The limits are counted per port, so
// each tab has the budget its own iframe has in smoldot-direct. There is no
// worker-wide cap: the pool shares the chains, so a session is a broker entry.

import { MAX_CONNECTIONS_PER_ORIGIN } from '@dotli/config';
import type { ChainPool, ProtocolEnvelope, StringJsonRpcConnection } from '@dotli/protocol';
import { PROTOCOL_APP_ERRORS } from './errors.js';

/** Chain connections one port (one tab) may hold. */
export const MAX_CHAIN_CONNECTIONS = 10;

export interface WorkerChainSessions {
  /** `chainConnect`: throws as the request handler did. */
  connect(port: MessagePort, origin: string, genesisHash: string, connectionId: string): void;
  /** `chainSend`: throws `Unknown chain connection` for an unknown id or another origin's. */
  send(origin: string, connectionId: string, message: string): void;
  /** `chainDisconnect`: an unknown id or another origin's is a no-op. */
  disconnect(origin: string, connectionId: string): void;
  /** Release every connection opened on `port`; returns how many. */
  removePort(port: MessagePort): number;
  readonly size: number;
}

interface Session {
  connection: StringJsonRpcConnection;
  port: MessagePort;
  origin: string;
}

export function createWorkerChainSessions(
  pool: ChainPool,
  isChainSupported: (genesisHash: string) => boolean,
  sendToPort: (port: MessagePort, envelope: ProtocolEnvelope) => void,
  log: (...args: unknown[]) => void,
): WorkerChainSessions {
  const sessions = new Map<string, Session>();
  const portConnections = new Map<MessagePort, Set<string>>();

  /** Connection ids are the client's own, so each origin has its own namespace (origins contain no spaces). */
  function connectionKey(origin: string, connectionId: string): string {
    return `${origin} ${connectionId}`;
  }

  function forget(key: string): Session | null {
    const session = sessions.get(key);
    if (session === undefined) {
      return null;
    }
    sessions.delete(key);
    const owned = portConnections.get(session.port);
    owned?.delete(key);
    if (owned?.size === 0) {
      portConnections.delete(session.port);
    }
    return session;
  }

  return {
    connect(port, origin, genesisHash, connectionId) {
      const key = connectionKey(origin, connectionId);
      if (sessions.has(key)) {
        throw new Error(`Duplicate chain connection: ${connectionId}`);
      }
      const portConns = portConnections.get(port) ?? new Set<string>();
      if (portConns.size >= MAX_CHAIN_CONNECTIONS) {
        throw new Error(`Connection limit reached (max ${String(MAX_CHAIN_CONNECTIONS)})`);
      }
      const originCount = [...portConns].filter(owned => sessions.get(owned)?.origin === origin).length;
      if (originCount >= MAX_CONNECTIONS_PER_ORIGIN) {
        throw new Error(`Per-origin connection limit reached (max ${String(MAX_CONNECTIONS_PER_ORIGIN)})`);
      }
      if (!isChainSupported(genesisHash)) {
        throw new Error(`Unsupported chain: ${genesisHash}`);
      }
      // The resolver and all dApp sessions share one Asset Hub chain via the
      // pool, so there is no resolver chain to release here; connect directly.
      let chainMsgCount = 0;
      const connection = pool.connectRemote(
        genesisHash,
        key,
        message => {
          chainMsgCount++;
          if (chainMsgCount <= 5 || chainMsgCount % 100 === 0) {
            log(`Chain message #${String(chainMsgCount)} for ${connectionId} (${String(message.length)} bytes)`);
          }
          sendToPort(port, {
            namespace: 'dotli:protocol',
            kind: 'chain-message',
            connectionId,
            message,
          });
        },
        () => {
          // The pool has answered this connection's pending requests and
          // stopped its follows by now; the tab drops it on `chain-halt`.
          if (forget(key) === null) {
            return;
          }
          log(`Chain halted: ${connectionId} (${String(sessions.size)} remaining)`);
          sendToPort(port, { namespace: 'dotli:protocol', kind: 'chain-halt', connectionId });
        },
      );
      if (connection === null) {
        throw new Error(PROTOCOL_APP_ERRORS.CHAIN_BROKER_FAILED);
      }
      sessions.set(key, { connection, port, origin });
      portConns.add(key);
      portConnections.set(port, portConns);
      log(`Chain connected: ${connectionId} (${String(sessions.size)} total)`);
    },

    send(origin, connectionId, message) {
      const session = sessions.get(connectionKey(origin, connectionId));
      if (session === undefined) {
        throw new Error(`Unknown chain connection: ${connectionId}`);
      }
      session.connection.send(message);
    },

    disconnect(origin, connectionId) {
      const session = forget(connectionKey(origin, connectionId));
      if (session === null) {
        return;
      }
      session.connection.disconnect();
      log(`Chain disconnected: ${connectionId} (${String(sessions.size)} remaining)`);
    },

    removePort(port) {
      let cleaned = 0;
      for (const [key, session] of [...sessions]) {
        if (session.port === port) {
          forget(key);
          session.connection.disconnect();
          cleaned++;
        }
      }
      return cleaned;
    },

    get size() {
      return sessions.size;
    },
  };
}
