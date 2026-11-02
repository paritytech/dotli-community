// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { TransportVersions } from './handshakeCodecs.js';

const VERSION_KINDS: readonly (keyof TransportVersions)[] = ['wire', 'schema'];

/**
 * The peer speaks another wire or schema version, so no call can cross. The message names each version that differs,
 * with both sides' values. A reload, not a retry, fixes it.
 */
export class TransportUnsupportedProtocolVersionError extends Error {
  readonly ours: TransportVersions;
  readonly theirs: TransportVersions;

  constructor(ours: TransportVersions, theirs: TransportVersions) {
    const differ = VERSION_KINDS.filter(kind => ours[kind] !== theirs[kind]);
    super(
      differ
        .map(kind => `The peer speaks ${kind} version ${String(theirs[kind])} and this side ${String(ours[kind])}.`)
        .join(' '),
    );
    this.name = 'TransportUnsupportedProtocolVersionError';
    this.ours = ours;
    this.theirs = theirs;
  }
}
