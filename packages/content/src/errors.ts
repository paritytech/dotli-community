// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Callers branch on `error.name`, not `instanceof`, because errors are rebuilt across postMessage.
// Kept apart from the throwing modules so importing a name pulls in no hashing code.

export const CONTENT_ERRORS = {
  /** Fetched bytes are not the content the CID names, or cannot be checked. */
  VERIFICATION: 'ContentVerificationError',
  /** The IPFS gateway sent nothing for longer than the fetch waits. */
  GATEWAY_STALLED: 'ContentGatewayStalledError',
  /** The IPFS gateway sent more bytes than one response may hold. */
  GATEWAY_TOO_LARGE: 'ContentGatewayTooLargeError',
} as const;
