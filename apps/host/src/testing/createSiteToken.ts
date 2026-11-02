// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { base64urlnopad } from '@scure/base';

/** A site token as a request carries it: base64url with no padding, of `bytes` bytes. */
export function createSiteToken(bytes: number): string {
  return base64urlnopad.encode(new Uint8Array(bytes).fill(7));
}
