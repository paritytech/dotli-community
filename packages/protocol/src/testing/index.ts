// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What a functional test needs to read the protocol frame's traffic in a real page. Never imported by shipped code.

import { toHex } from '@dotli/shared';
import { describeMessage } from '@dotli/transport/testing';
import { protocolSchema } from '../schema.js';

export interface DescribedWireMessage {
  trait: string;
  method: string;
  leg: string;
  id: number;
  /** The leg's decoded value, such as a payload or an outcome, with bytes as hex. */
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
  let described: DescribedWireMessage;
  try {
    described = describeMessage(protocolSchema, data);
  } catch {
    // Refused data is no message, and a recording keeps only messages.
    return null;
  }
  return { ...described, body: plain(described.body) };
}
