// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The SharedWorker's remote chain connections: one pool lease each, tied to
// the port that opened it, under the worker's connection limits.

import { MAX_CONNECTIONS_PER_ORIGIN } from '@dotli/config';
import type { ChainPool, ProtocolEnvelope, StringJsonRpcConnection } from '@dotli/protocol';
import { PROTOCOL_APP_ERRORS } from './errors.js';

export const MAX_CHAIN_CONNECTIONS = 10;

export interface WorkerChainSessions {
  /** `chainConnect`: throws as the request handler did. */
  connect(port: MessagePort, origin: string, genesisHash: string, connectionId: string): void;
  /** `chainSend`: throws `Unknown chain connection` for an unknown id. */
  send(origin: string, connectionId: string, message: string): void;
  /** `chainDisconnect`: an unknown id is a no-op. */
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
  const originConnections = new Map<string, Set<string>>();

  function forget(connectionId: string): Session | null {
    const session = sessions.get(connectionId);
    if (session === undefined) {
      return null;
    }
    sessions.delete(connectionId);
    const owned = originConnections.get(session.origin);
    owned?.delete(connectionId);
    if (owned?.size === 0) {
      originConnections.delete(session.origin);
    }
    return session;
  }

  return {
    connect(port, origin, genesisHash, connectionId) {
      if (sessions.size >= MAX_CHAIN_CONNECTIONS) {
        throw new Error(`Connection limit reached (max ${String(MAX_CHAIN_CONNECTIONS)})`);
      }
      const originConns = originConnections.get(origin) ?? new Set<string>();
      if (originConns.size >= MAX_CONNECTIONS_PER_ORIGIN) {
        throw new Error(`Per-origin connection limit reached (max ${String(MAX_CONNECTIONS_PER_ORIGIN)})`);
      }
      if (!isChainSupported(genesisHash)) {
        throw new Error(`Unsupported chain: ${genesisHash}`);
      }
      // The resolver and all dApp sessions share one Asset Hub chain via the
      // pool, so there is no resolver chain to release here; connect directly.
      let chainMsgCount = 0;
      const connection = pool.connectRemote(genesisHash, connectionId, message => {
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
      });
      if (connection === null) {
        throw new Error(PROTOCOL_APP_ERRORS.CHAIN_BROKER_FAILED);
      }
      sessions.set(connectionId, { connection, port, origin });
      originConns.add(connectionId);
      originConnections.set(origin, originConns);
      log(`Chain connected: ${connectionId} (${String(sessions.size)} total)`);
    },

    send(_origin, connectionId, message) {
      const session = sessions.get(connectionId);
      if (session === undefined) {
        throw new Error(`Unknown chain connection: ${connectionId}`);
      }
      session.connection.send(message);
    },

    disconnect(_origin, connectionId) {
      forget(connectionId)?.connection.disconnect();
      log(`Chain disconnected: ${connectionId} (${String(sessions.size)} remaining)`);
    },

    removePort(port) {
      let cleaned = 0;
      for (const [connectionId, session] of [...sessions]) {
        if (session.port === port) {
          forget(connectionId);
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
