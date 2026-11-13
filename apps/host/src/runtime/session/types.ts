// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { LoginFailureKind } from '@parity/truapi-host';
import type { TruapiSessionUiState } from './parseUiStateCache.js';

/**
 * The core's `AuthState` with byte fields converted for rendering, plus its pairing context.
 * `Restoring` and `Unreachable` are the host's own. Boot has not yet read the saved session, or the read failed, so
 * the user is neither signed in nor out. The session state layer leaves both on its own.
 */
export type DotliAuthState =
  | { tag: 'Restoring' }
  | { tag: 'Unreachable' }
  | { tag: 'Disconnected' }
  | {
      tag: 'Pairing';
      deeplink: string;
      label: string;
      dotSuffix?: boolean | undefined;
      hostGlobal?: boolean | undefined;
    }
  | { tag: 'Authenticating' }
  | { tag: 'Connected'; session: TruapiSessionUiState }
  | { tag: 'LoginFailed'; kind: LoginFailureKind; reason: string };

/**
 * A state a core reported, as the page shows it, and whether that core still speaks for the page. A core goes out of
 * service when it goes down or turns stale, and reports nothing after.
 */
export type CoreReport = { auth: DotliAuthState; isInService: () => boolean };

/** The auth state while the core pairs, with what the pairing presents. */
export type PairingState = Extract<DotliAuthState, { tag: 'Pairing' }>;

/** Whether some sign-in exists on the root domain, or `unknown` when the flag cannot be read. */
export type Presence = 'present' | 'absent' | 'unknown';

/**
 * The signed-in flag on the root domain, which holds presence only. Each call rejects when the flag cannot be reached,
 * unless the implementation states that it never rejects.
 */
export type SessionPresence = {
  /** Reads the flag, probing once per page whether it can be read when it is not there. */
  read(): Promise<Presence>;
  /** Settles once the flag is written, at once for the cookie and when the request ends for the dev store. */
  set(): Promise<void>;
  /** Deletes the flag, and settles as `set` does. */
  clear(): Promise<void>;
  /**
   * Extends the flag's lifetime only if it is set at that moment, so a sign-out elsewhere is not undone.
   */
  renew(): Promise<void>;
};
