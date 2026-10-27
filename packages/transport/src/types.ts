// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Address } from './defineSchema.js';
import type { Failure } from './failure.js';
import type { MessageBytes } from './messageBytes.js';

/** What a handler knows about the peer that called it. */
export type CallContext<Hello> = {
  /** The peer's handshake hello. */
  hello: Hello;
};

/** A method's handler, as the peer's calls reach it. */
export type Served<Hello> = (call: ServedCall<Hello>) => void;

/** A message of the peer's call `id`, as its bytes, with what the handshake told of the peer. */
export type ServedCall<Hello> = {
  /** The peer's call id. */
  id: number;
  /** The message on the call, as its bytes. */
  message: MessageBytes;
  /** What the handshake told of the peer. */
  context: CallContext<Hello>;
};

/** A subscription the peer opened, as its stop reaches it. */
export type Running = {
  /** Where the subscription's method sits. */
  address: Address;
  /** Hands it a message of the peer's, as its bytes. */
  hear(message: MessageBytes): void;
  /** Ends it with nothing sent, and runs its stop function. */
  drop(): void;
};

/** What a call opened for a forwarder hears from the peer it went to. */
export type Heard = {
  /** A message on the call, as its bytes. */
  message(bytes: MessageBytes): void;
  /** The failure the peer answered the call with, which ends it. */
  fail(error: Failure): void;
  /** The transport closed with `error`, which ends the call. */
  close(error: Error): void;
};
