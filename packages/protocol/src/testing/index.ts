// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What a functional test needs to fake the protocol frame and read its traffic in a real page. Never imported by
// shipped code.

import { toHex } from '@dotli/shared';
import { decodeWireMessage } from '../wire-message.js';

export { createWindowProvider } from '../provider.js';
export { createServingTransport } from '../transport.js';

export interface DescribedWireMessage {
  method: string;
  leg: string;
  id: number;
  /** The leg's own fields, such as `payload`, `event` or `error`, with bytes as hex. */
  body: unknown;
}

/** Bytes become hex, so a record crosses out of the page as plain JSON. */
function plain(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return toHex(value);
  }
  if (Array.isArray(value)) {
    return value.map(plain);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, plain(field)]));
  }
  return value;
}

/** A wire message as a test reads it, or null for data that does not decode as one. */
export function describeWireMessage(data: unknown): DescribedWireMessage | null {
  if (!(data instanceof ArrayBuffer)) {
    return null;
  }
  const decoded = decodeWireMessage(data);
  if (!decoded.ok) {
    return null;
  }
  const { method, leg, id, ...body } = decoded.message;
  return { method, leg, id, body: plain(body) };
}
