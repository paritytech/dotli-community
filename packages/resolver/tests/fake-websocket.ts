// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A browser WebSocket stand-in for driving @polkadot-api/ws-provider in
// tests. Install it with `vi.stubGlobal('WebSocket', FakeWebSocket)` before
// building a provider, and reset `FakeWebSocket.instances` between tests.
// It plays a node that answers `rpc_methods` with `FakeWebSocket.methods`,
// which @polkadot-api/ws-middleware probes on every new socket before it lets
// other traffic through. Restore `methods` if a test changes it.

import type { JsonRpcRequest } from '@polkadot-api/json-rpc-provider';

type Listener = (event: unknown) => void;

export class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  /** Every socket constructed since the last reset, oldest first. */
  static instances: FakeWebSocket[] = [];
  /** The methods the fake server reports for `rpc_methods`. */
  static methods: string[] = [
    'chainHead_v1_follow',
    'chainHead_v1_unfollow',
    'chainHead_v1_header',
    'chainHead_v1_body',
    'chainHead_v1_call',
    'chainHead_v1_storage',
    'chainHead_v1_unpin',
    'chainHead_v1_continue',
    'chainHead_v1_stopOperation',
    'chainSpec_v1_genesisHash',
    'chainSpec_v1_chainName',
    'chainSpec_v1_properties',
    'transaction_v1_broadcast',
    'transaction_v1_stop',
    'transactionWatch_v1_submitAndWatch',
    'transactionWatch_v1_unwatch',
    'statement_subscribeStatement',
    'statement_unsubscribeStatement',
    'statement_submit',
    'rpc_methods',
  ];

  readonly url: string;
  readonly sent: string[] = [];
  readyState: number = FakeWebSocket.CONNECTING;
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(url: string | URL) {
    this.url = String(url);
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    const forType = this.listeners.get(type) ?? new Set<Listener>();
    forType.add(listener);
    this.listeners.set(type, forType);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    this.sent.push(data);
    const message = JSON.parse(data) as JsonRpcRequest;
    if (message.method === 'rpc_methods') {
      this.deliver({ jsonrpc: '2.0', id: message.id, result: { methods: [...FakeWebSocket.methods] } });
    }
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) {
      return;
    }
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close', { type: 'close' });
  }

  /** The server accepts the connection. */
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open', { type: 'open' });
  }

  /** The server sends `message`. */
  deliver(message: unknown): void {
    this.emit('message', { data: JSON.stringify(message) });
  }

  /** The requests sent on this socket with `method`, in order. */
  requests(method: string): JsonRpcRequest[] {
    return this.sent
      .map(raw => JSON.parse(raw) as JsonRpcRequest)
      .filter(message => message.method === method);
  }

  private emit(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event);
    }
  }
}
