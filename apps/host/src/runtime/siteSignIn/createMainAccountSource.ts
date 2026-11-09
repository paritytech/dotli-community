// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The main account a site's round runs for, as the window's own core reports it. The saved copy may show a session
// before any core reported one, and a local wallet's copy carries no key, so the source reads only the core's report.
// It holds a lease on that core, so the core stays up from the read to the round's signer calls.

import {
  hashBlake2b,
  createAsyncTaskPool,
  createDeferred,
  fromHex,
  noop,
  toHex,
  waitForStatus,
  type StatusSource,
} from '@dotli/shared';
import type { ReadableAtom } from 'nanostores';
import type { CoreLease } from '../createPageCore.js';
import { authViews } from '../session/authViews.js';
import type { DotliAuthState } from '../session/types.js';
import type { TruapiSessionUiState } from '../session/parseUiStateCache.js';

/** The main account an action runs for. The round never sends any of it. */
export type MainAccount = {
  /** Hex of the hash of the main account's public key, whose grants these are. */
  owner: string;
  /** Null for an account with no username to show a site. */
  username: { name: string; kind: 'lite' | 'full' } | null;
};

/** The main account a site's round runs for, as the window's own core reports it. */
export type MainAccountSource = ReturnType<typeof createMainAccountSource>;

type MainAccountErrorKind = 'unavailable' | 'signed_out';

/** The two lease calls the source makes. */
type HeldLease = Pick<CoreLease, 'subscribeDown' | 'release'>;

/** The core's report while the leased core is up, or `down` once it went down. */
type LeasedReport = DotliAuthState | null | 'down';

type Params = {
  /** Takes a lease on the page's core, booting it when none runs. Rejects when the core cannot boot. */
  acquire: () => Promise<HeldLease>;
  /** What the page's core itself reported last, null while no core reported. */
  coreReport: Pick<ReadableAtom<DotliAuthState | null>, 'get' | 'listen'>;
};

/** A key the core reports as `0x` hex of whole bytes. */
const HEX_KEY = /^0x(?:[0-9a-fA-F]{2})+$/;

/** Makes the source, which takes its lease on the first read. */
export function createMainAccountSource({ acquire, coreReport }: Params) {
  // One lease at a time, so overlapping reads share the one the first read takes.
  const leases = createAsyncTaskPool({ poolSize: 1 });
  // Aborts on dispose, which ends every read open then or started after.
  const lifetime = new AbortController();
  // The lease held, with its own signal that aborts once its core goes down, and the removal of its down listener.
  let held: { lease: HeldLease; down: AbortSignal; unsubscribeDown: () => void } | null = null;
  // The report on show when the last held lease went down. The page keeps the dead core's last report until its
  // replacement reports, and a replacement is dialed before its holders hear the down.
  let staleReport: DotliAuthState | null = null;

  /** Takes a lease unless one is held, and lets it go once its core goes down. Resolves with the lease's down signal. */
  async function holdLease(): Promise<AbortSignal> {
    if (held !== null) {
      return held.down;
    }
    const lease = await acquire();
    // The read that took it has already failed, so a lease landing after dispose is let go and never held.
    if (lifetime.signal.aborted) {
      lease.release();
      throw new MainAccountError('unavailable', 'The main account source was disposed while it took a lease');
    }
    const down = new AbortController();
    const current = { lease, down: down.signal, unsubscribeDown: noop };
    // Held before the subscribe, which calls the listener at once for a core that went down since it was acquired.
    held = current;
    current.unsubscribeDown = lease.subscribeDown(() => {
      if (held === current) {
        held = null;
      }
      staleReport = coreReport.get();
      down.abort();
      lease.release();
    });
    return down.signal;
  }

  function dispose(): void {
    lifetime.abort(new Error('The main account source was disposed'));
    if (held === null) {
      return;
    }
    const { lease, unsubscribeDown } = held;
    held = null;
    unsubscribeDown();
    lease.release();
  }

  /** The core's report while the leased core is up, and `down` once it went down, since a replacement reports anew. */
  function watchLeasedReport(down: AbortSignal): StatusSource<LeasedReport> {
    function getReport(): LeasedReport {
      if (down.aborted) {
        return 'down';
      }
      const report = coreReport.get();
      return report === staleReport ? null : report;
    }
    return {
      get: getReport,
      listen(listener) {
        function notify(): void {
          listener(getReport());
        }
        down.addEventListener('abort', notify, { once: true });
        const unsubscribeReport = coreReport.listen(notify);
        function unsubscribe(): void {
          down.removeEventListener('abort', notify);
          unsubscribeReport();
        }
        return unsubscribe;
      },
    };
  }

  /**
   * The session the core reports once it reports one, null once its core goes down first, or the reason it never
   * will.
   */
  function waitForSession(down: AbortSignal, signal: AbortSignal): Promise<TruapiSessionUiState | null> {
    const session = createDeferred<TruapiSessionUiState | null>();
    waitForStatus(
      watchLeasedReport(down),
      report => {
        if (report === 'down') {
          session.resolve(null);
          return true;
        }
        // No report yet keeps the wait.
        if (report === null) {
          return false;
        }
        const signedIn = authViews.getSignedInSession(report);
        if (signedIn !== null) {
          session.resolve(signedIn);
          return true;
        }
        if (authViews.isSignInIdle(report)) {
          return new MainAccountError('signed_out', `The window's core reports the main session ${report.tag}`);
        }
        if (authViews.isSessionUnreachable(report)) {
          return new MainAccountError('unavailable', "The window's core cannot read the main session");
        }
        // A report on the way to a session keeps the wait.
        return false;
      },
      { signal },
    ).catch(session.reject);
    return session.promise;
  }

  return {
    /**
     * The main account once the core reports a session, on a core lease the source holds from the first read. Rejects
     * with a {@link MainAccountError}: `signed_out` once the core reports no session or a failed login, `unavailable`
     * for a core that cannot boot, a core that cannot read the main session, a session without a readable key,
     * `signal` aborting first, or the source disposed while the read is open or before it starts, which then takes no
     * new lease. After the leased core went down, the read waits for its replacement's own report.
     */
    async read(signal: AbortSignal): Promise<MainAccount> {
      const ended = AbortSignal.any([signal, lifetime.signal]);
      try {
        for (;;) {
          // A core that went down while the read waited is leased again, and a replacement that cannot boot fails the
          // read with its error.
          const down = await leases.call(holdLease, { signal: ended });
          const session = await waitForSession(down, ended);
          if (session === null) {
            continue;
          }
          const account = getMainAccount(session);
          if (account === null) {
            throw new MainAccountError('unavailable', "The core's session has no readable public key");
          }
          return account;
        }
      } catch (error) {
        if (error instanceof MainAccountError) {
          throw error;
        }
        throw new MainAccountError('unavailable', 'The main account could not be read', { cause: error });
      }
    },
    /**
     * Removes the down listener of the held lease and lets the lease go, lets go of a lease still being taken as soon
     * as it lands, fails every open read as `unavailable`, is safe to call twice and never throws.
     */
    dispose,
  };
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
