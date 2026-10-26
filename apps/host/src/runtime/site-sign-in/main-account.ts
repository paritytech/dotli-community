// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The main account a site's round runs for, as the window's own core reports it. The saved copy may show a session
// before any core reported one, and a local wallet's copy carries no key, so the source reads only the core's report.
// It holds a lease on that core, so the core stays up from the read to the round's signer calls.

import {
  blake2b,
  createAsyncTaskPool,
  deferred,
  fromHex,
  toHex,
  untilStatus,
  type ReadableStore,
  type StatusCell,
} from '@dotli/shared';
import type { CoreLease } from '../page-core.js';
import type { DotliAuthState } from '../session/auth-state.js';
import type { TruapiSessionUiState } from '../session/ui-state.js';

/** The main account an action runs for. The round never sends any of it. */
export type MainAccount = {
  /** Hex of the hash of the main account's public key, whose grants these are. */
  owner: string;
  /** Null for an account with no username to show a site. */
  username: { name: string; kind: 'lite' | 'full' } | null;
};

/** A key the core reports as `0x` hex of whole bytes. */
const HEX_KEY = /^0x(?:[0-9a-fA-F]{2})+$/;

/** The main account of a session, or null for one without a readable public key. */
export function mainAccountOf(session: TruapiSessionUiState): MainAccount | null {
  const { publicKey } = session;
  if (publicKey === undefined || !HEX_KEY.test(publicKey)) {
    return null;
  }
  const owner = toHex(blake2b(fromHex(publicKey), 32));
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
  readonly kind: 'unavailable' | 'signed_out';

  constructor(kind: 'unavailable' | 'signed_out', message: string, cause?: unknown) {
    super(message, { cause });
    this.kind = kind;
  }
}

/** The two lease calls the source makes. */
type HeldLease = Pick<CoreLease, 'subscribeDown' | 'release'>;

export type MainAccountSourceDeps = {
  /** Takes a lease on the page's core, booting it when none runs. Rejects when the core cannot boot. */
  acquire: () => Promise<HeldLease>;
  /** What the page's core itself reported last, null while no core reported. */
  coreReport: ReadableStore<DotliAuthState | null>;
};

export type MainAccountSource = {
  /**
   * The main account once the core reports a session, on a core lease the source holds from the first read. Rejects
   * with a {@link MainAccountError}: `signed_out` once the core reports no session or a failed login, `unavailable`
   * for a core that cannot boot, a session without a readable key, or `signal` aborting first.
   */
  read(signal: AbortSignal): Promise<MainAccount>;
};

export function createMainAccountSource(deps: MainAccountSourceDeps): MainAccountSource {
  // One lease at a time, so overlapping reads share the one the first read takes.
  const leases = createAsyncTaskPool({ poolSize: 1 });
  // The lease held, with its own signal that aborts once its core goes down.
  let held: { lease: HeldLease; down: AbortSignal } | null = null;

  /** Takes a lease unless one is held, and lets it go once its core goes down. Resolves with the lease's down signal. */
  const hold = async (): Promise<AbortSignal> => {
    if (held !== null) {
      return held.down;
    }
    const lease = await deps.acquire();
    const down = new AbortController();
    const current = { lease, down: down.signal };
    // Held before the subscribe, which calls the listener at once for a core that went down since it was acquired.
    held = current;
    lease.subscribeDown(() => {
      if (held === current) {
        held = null;
      }
      down.abort();
      lease.release();
    });
    return down.signal;
  };

  /** The core's report while the leased core is up, and `down` once it went down, since a replacement reports anew. */
  const reportOn = (down: AbortSignal): Pick<StatusCell<DotliAuthState | null | 'down'>, 'get' | 'subscribe'> => {
    const get = (): DotliAuthState | null | 'down' => (down.aborted ? 'down' : deps.coreReport.get());
    return {
      get,
      subscribe: listener => {
        const onChange = (): void => {
          listener(get());
        };
        down.addEventListener('abort', onChange, { once: true });
        const unsubscribe = deps.coreReport.subscribe(onChange);
        return () => {
          down.removeEventListener('abort', onChange);
          unsubscribe();
        };
      },
    };
  };

  /**
   * The session the core reports once it reports one, null once its core goes down first, or the reason it never
   * will.
   */
  const reported = (down: AbortSignal, signal: AbortSignal): Promise<TruapiSessionUiState | null> => {
    const session = deferred<TruapiSessionUiState | null>();
    untilStatus(
      reportOn(down),
      report => {
        if (report === 'down') {
          session.resolve(null);
          return true;
        }
        // No report yet, or one on the way to a session, keeps the wait.
        switch (report?.tag) {
          case 'Connected':
            session.resolve(report.session);
            return true;
          case 'Disconnected':
          case 'LoginFailed':
            return new MainAccountError('signed_out', `The window's core reports the main session ${report.tag}`);
          case undefined:
          case 'Restoring':
          case 'Unreachable':
          case 'Pairing':
          case 'Authenticating':
            return false;
        }
      },
      signal,
    ).catch(session.reject);
    return session.promise;
  };

  return {
    async read(signal) {
      try {
        for (;;) {
          // A core that went down while the read waited is leased again, and a replacement that cannot boot fails the
          // read with its error.
          const down = await leases.call(hold, { signal });
          const session = await reported(down, signal);
          if (session === null) {
            continue;
          }
          const account = mainAccountOf(session);
          if (account === null) {
            throw new MainAccountError('unavailable', "The core's session has no readable public key");
          }
          return account;
        }
      } catch (error) {
        if (error instanceof MainAccountError) {
          throw error;
        }
        throw new MainAccountError('unavailable', 'The main account could not be read', error);
      }
    },
  };
}
