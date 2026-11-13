// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The main account a site's round runs for, as a core's report of the main session names it.

import { fromHex, hashBlake2b, toHex } from '@dotli/shared';
import { authViews } from '../session/authViews.js';
import type { TruapiSessionUiState } from '../session/parseUiStateCache.js';
import type { DotliAuthState } from '../session/types.js';

/** The main account an action runs for. The round never sends any of it. */
export type MainAccount = {
  /** Hex of the hash of the main account's public key, whose grants these are. */
  owner: string;
  /** Null for an account with no username to show a site. */
  username: { name: string; kind: 'lite' | 'full' } | null;
};

/** What a core's report answers a read of the main account. */
export type ReportVerdict =
  { kind: 'waiting' } | { kind: 'read'; account: MainAccount } | { kind: 'failed'; error: MainAccountError };

type MainAccountErrorKind = 'unavailable' | 'signed_out';

/** A key the core reports as `0x` hex of whole bytes. */
const HEX_KEY = /^0x(?:[0-9a-fA-F]{2})+$/;

/** What the core's report `shown` answers a read. A report on the way to a session keeps the read waiting. */
export function judgeReport(shown: DotliAuthState): ReportVerdict {
  const session = authViews.getSignedInSession(shown);
  if (session !== null) {
    const account = getMainAccount(session);
    if (account === null) {
      return {
        kind: 'failed',
        error: new MainAccountError('unavailable', "The core's session has no readable public key"),
      };
    }
    return { kind: 'read', account };
  }
  if (authViews.isSignInIdle(shown)) {
    return {
      kind: 'failed',
      error: new MainAccountError('signed_out', `The window's core reports the main session ${shown.tag}`),
    };
  }
  if (authViews.isSessionUnreachable(shown)) {
    return {
      kind: 'failed',
      error: new MainAccountError('unavailable', "The window's core cannot read the main session"),
    };
  }
  return { kind: 'waiting' };
}

/** The main account of a session, or null for one without a readable public key. */
export function getMainAccount(session: TruapiSessionUiState): MainAccount | null {
  const { publicKey } = session;
  if (publicKey === undefined || !HEX_KEY.test(publicKey)) {
    return null;
  }
  const owner = toHex(hashBlake2b(fromHex(publicKey), 32));
  if (session.fullUsername !== undefined && session.fullUsername !== '') {
    return { owner, username: { name: session.fullUsername, kind: 'full' } };
  }
  if (session.liteUsername !== undefined && session.liteUsername !== '') {
    return { owner, username: { name: session.liteUsername, kind: 'lite' } };
  }
  return { owner, username: null };
}

/**
 * Why the main account could not be read. `signed_out` is a session the core reports gone, which only a new sign-in
 * brings back, and `unavailable` anything else, which a read may get past.
 */
export class MainAccountError extends Error {
  override name = 'MainAccountError';
  readonly kind: MainAccountErrorKind;

  constructor(kind: MainAccountErrorKind, message: string, { cause }: ErrorOptions = {}) {
    super(message, { cause });
    this.kind = kind;
  }
}
