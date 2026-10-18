// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the transport hands its parts: the handshake, the calls this side makes and the calls it serves.

import type { ResultPayload } from 'scale-ts';
import type { Address } from './schema.js';

/**
 * Posts bytes, of the call at `address` when they belong to one. A post the provider throws on is already reported
 * when it returns the error.
 */
export type Post = (data: ArrayBuffer, address?: Address) => ResultPayload<undefined, Error>;

/** Reports a message that does not decode, or does not fit what it names. */
export type Refuse = (reason: 'malformed' | 'invalid', cause: Error) => void;

/** Runs a callback of the owner's. One that throws is reported as `listener_threw`, and the transport carries on. */
export type RunListener = (listener: () => void) => void;
