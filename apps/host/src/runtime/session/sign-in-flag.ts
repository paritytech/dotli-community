// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// How a page's writes and clears of a stored sign-in move the signed-in flag. A page that makes sign-ins in the main
// store owns the flag together with that store, and any other page drops it with the session its own core drops.

import { createAsyncTaskPool, log } from '@dotli/shared';
import { ownsFlag, type PageRole } from '../page-role.js';
import type { SessionPresence } from './presence.js';

export interface SignInFlag {
  /** Runs a write of a sign-in. Rejects when the write rejects. */
  store(write: () => Promise<void> | void): Promise<void>;
  /**
   * Runs a clear of a sign-in, which resolves whether it cleared one, and resolves with that. Without one, only the
   * flag is brought in line with the store. Rejects when the clear rejects.
   */
  clear(clear?: () => Promise<boolean>): Promise<boolean>;
  /**
   * Extends the flag's lifetime only if it is set at that moment, so a sign-out elsewhere is not undone. Every keeper
   * renews, so the flag lives as long as the user keeps using dotli. Needs no queue. Reports its own failure.
   */
  renew(): void;
}

const NOTHING_TO_CLEAR = (): Promise<boolean> => Promise.resolve(false);

/** Whether the page's copy holds a paired session or a local wallet, or `unread` when a read failed. */
export type StoredSignIn = 'held' | 'none' | 'unread';

export interface SignInFlagDeps {
  /** The signed-in flag. Never rejects, and reports its own failed writes. */
  presence: Pick<SessionPresence, 'set' | 'clear' | 'renew'>;
  /** Records its own failed reads. Never rejects. Each keeper decides what an `unread` copy means for the flag. */
  storedSignIn: () => Promise<StoredSignIn>;
}

/**
 * The flag keeper of a page that does not own the flag. It renews a flag that is still set, never raises the flag for
 * its own writes, since its core only rewrites a sign-in the flag already covers, and deletes it with a sign-in its own
 * core drops, raising it only again after that drop, for a sign-in stored meanwhile. A store that refuses the clear
 * still has every page drop the sign-in on its next load. A sign-in stored since the core's read is another one, which
 * the flag still covers.
 */
export function pageSignInFlag(deps: SignInFlagDeps): SignInFlag {
  const { presence, storedSignIn } = deps;

  /**
   * A sign-in stored elsewhere after the drop raised the flag before its write, which this delete may have undone, so
   * a copy that holds one now raises it again. The owner raises it once more after its write, so whichever lands last
   * covers it. Where the copy is not the main store, such as a product's in Safari, this read cannot see that sign-in.
   * A copy that cannot be read leaves the flag down, since raising it for nothing would undo a sign-out everywhere.
   */
  const dropFlag = async (): Promise<void> => {
    await presence.clear();
    const stored = await storedSignIn();
    if (stored === 'held') {
      await presence.set();
    } else if (stored === 'unread') {
      log.event('signed-in flag left down after a drop, the copy could not be read', { flow: 'wallet' });
    }
  };

  return {
    async store(write) {
      await write();
    },
    async clear(clear = NOTHING_TO_CLEAR) {
      let cleared: boolean;
      try {
        cleared = await clear();
      } catch (error) {
        // The store still holds the session the core read, so a read now could not tell it from a new sign-in.
        void presence.clear();
        throw error;
      }
      if (cleared) {
        await dropFlag();
      }
      return cleared;
    },
    renew() {
      void presence.renew();
    },
  };
}

/**
 * The one writer of the main store on a page that owns the flag: the sign-in window, a preview opened on its own or the
 * landing page. It raises the flag with each sign-in it stores, its core's included, and before the write, since a
 * page that loaded between the store write and a later flag would read the sign-in as dead, and the flag goes once the
 * store holds none. Its writes and clears run one at a time, so the check that the store holds nothing and the flag's
 * delete never interleave with a sign-in being stored, the core's included.
 */
export function ownerSignInFlag(deps: SignInFlagDeps): SignInFlag {
  const { presence, storedSignIn } = deps;
  const steps = createAsyncTaskPool({ poolSize: 1 });

  // A store that cannot be read may still hold a sign-in, so the flag stays for it.
  const dropIfEmpty = async (): Promise<void> => {
    if ((await storedSignIn()) === 'none') {
      await presence.clear();
    }
  };

  return {
    store: write =>
      steps.call(async () => {
        // Landed first, as the dev store's write is a request.
        await presence.set();
        try {
          await write();
        } catch (error) {
          await dropIfEmpty();
          throw error;
        }
        // Again, as a page whose core dropped another session may have deleted it between the two.
        await presence.set();
      }),
    clear: (clear = NOTHING_TO_CLEAR) =>
      steps.call(async () => {
        const cleared = await clear();
        await dropIfEmpty();
        return cleared;
      }),
    renew() {
      void presence.renew();
    },
  };
}

export interface PageSignInFlagDeps extends SignInFlagDeps {
  role: () => PageRole;
}

/** The page's flag keeper, picked by the page's role on first use, as the role is chosen after the module loads. */
export function createPageSignInFlag(deps: PageSignInFlagDeps): SignInFlag {
  let inner: SignInFlag | undefined;
  const get = (): SignInFlag => (inner ??= ownsFlag(deps.role()) ? ownerSignInFlag(deps) : pageSignInFlag(deps));
  return {
    store: write => get().store(write),
    clear: clear => get().clear(clear),
    renew: () => {
      get().renew();
    },
  };
}
