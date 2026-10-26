// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { deferred } from '@dotli/shared';
import type { PageRole } from '../page-role.js';
import { createFakeSessionPresence, type FakeSessionPresence } from './presence.fake.js';
import {
  createPageSignInFlag,
  ownerSignInFlag,
  pageSignInFlag,
  type SignInFlag,
  type StoredSignIn,
} from './sign-in-flag.js';

/** The main store as the window's keeper sees it, with the order of every flag write and store change. */
function mainStore(initial: { session?: boolean; wallet?: boolean } = {}) {
  const presence = createFakeSessionPresence('absent');
  const store = { session: initial.session ?? false, wallet: initial.wallet ?? false };
  const steps: string[] = [];
  const set = presence.set.bind(presence);
  const clear = presence.clear.bind(presence);
  presence.set = () => {
    steps.push('flag set');
    return set();
  };
  presence.clear = () => {
    steps.push('flag clear');
    return clear();
  };
  let gate: Promise<void> | null = null;
  const signIns = ownerSignInFlag({
    presence,
    // Reads the store first, so a held check answers the store from before the hold, which a frame read in flight
    // has already read.
    storedSignIn: async () => {
      const holds = store.session || store.wallet;
      await gate;
      return holds ? 'held' : 'none';
    },
  });
  return {
    presence,
    store,
    steps,
    signIns,
    /** Holds the keeper's next check of the store until the returned release. */
    holdCheck: () => {
      const held = deferred<undefined>();
      gate = held.promise.then(() => {
        gate = null;
      });
      return () => {
        held.resolve(undefined);
      };
    },
  };
}

describe('flag owner', () => {
  it('As a user in the sign-in window, I store a sign-in and the flag goes up first and again once it landed', async () => {
    // Given the window's flag keeper over an empty store
    const { store, steps, signIns, presence } = mainStore();

    // When a sign-in is stored
    await signIns.store(() => {
      steps.push('session stored');
      store.session = true;
    });

    // Then the flag went up before and after the store
    expect(steps).toEqual(['flag set', 'session stored', 'flag set']);
    expect(presence.state).toBe('present');
  });

  it('As a user in the sign-in window, I fail to save on an empty store and the flag goes down again', async () => {
    // Given the window's flag keeper over an empty store and a save that fails
    const { signIns, presence } = mainStore();
    const failure = new Error('quota');

    // When the save runs
    const saving = signIns.store(() => Promise.reject(failure));

    // Then the save rejects and the flag goes up and back down
    await expect(saving).rejects.toBe(failure);
    expect(presence.calls).toEqual(['set', 'clear']);
    expect(presence.state).toBe('absent');
  });

  it('As a user in the sign-in window, I fail to save beside a stored session and the flag stays for it', async () => {
    // Given the window's flag keeper over a stored session
    const { signIns, presence } = mainStore({ session: true });

    // When a save fails
    const saving = signIns.store(() => Promise.reject(new Error('quota')));

    // Then the save rejects and the flag stays up
    await expect(saving).rejects.toThrow('quota');
    expect(presence.state).toBe('present');
  });

  it('As a user in the sign-in window, I clear the store in steps and the flag stays while a wallet is left and drops with the clear that empties it', async () => {
    // Given the window's flag keeper over a stored session and wallet
    const { store, signIns, presence } = mainStore({ session: true, wallet: true });
    presence.state = 'present';

    // When the session goes
    const dropped = await signIns.clear(() => {
      store.session = false;
      return Promise.resolve(true);
    });

    // Then the clear dropped the session and the flag stays for the wallet
    expect(dropped).toBe(true);
    expect(presence.state).toBe('present');

    // When the wallet goes too
    await signIns.clear(() => {
      store.wallet = false;
      return Promise.resolve(true);
    });

    // Then the flag drops
    expect(presence.state).toBe('absent');
  });

  it('As a user in the sign-in window, I clear a store that cannot be read afterwards and the flag stays for what it may hold', async () => {
    // Given the window's flag keeper over a store that cannot be read
    const presence = createFakeSessionPresence('present');
    const signIns = ownerSignInFlag({ presence, storedSignIn: () => Promise.resolve('unread') });

    // When a clear runs
    await signIns.clear(() => Promise.resolve(true));

    // Then the flag stays up
    expect(presence.state).toBe('present');
  });

  it('As a user in the sign-in window, I fail to clear and the flag stays for what is still stored', async () => {
    // Given the window's flag keeper over a stored wallet
    const { signIns, presence } = mainStore({ wallet: true });
    presence.state = 'present';

    // When a clear fails
    const clearing = signIns.clear(() => Promise.reject(new Error('frame down')));

    // Then the clear rejects and the flag is not touched
    await expect(clearing).rejects.toThrow('frame down');
    expect(presence.calls).toEqual([]);
    expect(presence.state).toBe('present');
  });

  it('As a user in the sign-in window, I pair while a clear checks the store and the session my core stores keeps its flag', async () => {
    // Given a clear of an empty store whose check is still in flight
    const { store, steps, signIns, presence, holdCheck } = mainStore();
    const releaseCheck = holdCheck();
    const clearing = signIns.clear();

    // When the core stores its session meanwhile
    const storing = signIns.store(() => {
      steps.push('session stored');
      store.session = true;
    });
    releaseCheck();
    await Promise.all([clearing, storing]);

    // Then the clear finished first, and the flag the core raised stays with its session
    expect(steps).toEqual(['flag clear', 'flag set', 'session stored', 'flag set']);
    expect(presence.state).toBe('present');
  });
});

describe('page flag keeper', () => {
  it('As a product page, I let my core store a session and never raise the flag', async () => {
    // Given a product page's flag keeper over an absent flag
    const presence = createFakeSessionPresence('absent');
    const flag = pageSignInFlag({ presence, storedSignIn: () => Promise.resolve('none') });
    let stored = false;

    // When the core stores a session
    await flag.store(() => {
      stored = true;
    });

    // Then the session is stored and the flag is not touched
    expect(stored).toBe(true);
    expect(presence.calls).toEqual([]);
  });

  it('As a page whose core drops its session, I delete the flag, and a clear that dropped nothing keeps it', async () => {
    // Given a page's flag keeper over a present flag
    const presence = createFakeSessionPresence('present');
    const flag = pageSignInFlag({ presence, storedSignIn: () => Promise.resolve('none') });

    // When a clear finds another sign-in stored since
    const kept = await flag.clear(() => Promise.resolve(false));

    // Then the flag stays
    expect(kept).toBe(false);
    expect(presence.state).toBe('present');

    // When the core drops the session it held
    await flag.clear(() => Promise.resolve(true));

    // Then the flag is deleted
    expect(presence.state).toBe('absent');
  });

  it('As a page whose copy cannot be read after my core dropped its session, I leave the flag down', async () => {
    // Given a page's flag keeper over a copy that cannot be read
    const presence = createFakeSessionPresence('present');
    const flag = pageSignInFlag({ presence, storedSignIn: () => Promise.resolve('unread') });

    // When the core's clear lands
    await flag.clear(() => Promise.resolve(true));

    // Then the sign-out reaches every other page
    expect(presence.calls).toEqual(['clear']);
    expect(presence.state).toBe('absent');
  });

  it('As a page whose store refuses the clear, I still delete the flag so every page drops it on load', async () => {
    // Given a page's flag keeper over a store holding a sign-in
    const presence = createFakeSessionPresence('present');
    const flag = pageSignInFlag({ presence, storedSignIn: () => Promise.resolve('held') });

    // When the store refuses the clear
    const clearing = flag.clear(() => Promise.reject(new Error('frame down')));

    // Then the clear rejects and the flag is still deleted
    await expect(clearing).rejects.toThrow('frame down');
    expect(presence.state).toBe('absent');
  });
});

describe('a page drop racing a sign-in on the shared store', () => {
  /** One shared store and flag, a page's keeper and an owner's, as two tabs in a browser that shares the store. */
  function twoTabs() {
    const presence = createFakeSessionPresence('present');
    const store = { session: 'old' as string | null };
    const storedSignIn = (): Promise<StoredSignIn> => Promise.resolve(store.session === null ? 'none' : 'held');
    return {
      presence,
      store,
      page: pageSignInFlag({ presence, storedSignIn }),
      owner: ownerSignInFlag({ presence, storedSignIn }),
    };
  }

  it('As a page whose delete lands after a sign-in elsewhere stored, I raise the flag again for it', async () => {
    // Given a product tab and the window's tab over one store
    const { presence, store, page, owner } = twoTabs();

    // When my core drops its session, and the owner signs in before my delete lands
    await page.clear(async () => {
      store.session = null;
      await owner.store(() => {
        store.session = 'new';
      });
      return true;
    });

    // Then the new sign-in stays and the flag is up
    expect(store.session).toBe('new');
    expect(presence.state).toBe('present');
  });

  it('As a page that owns the flag, I raise it again when my write lands after another page deleted the flag I raised', async () => {
    // Given the owner's flag up, and its write held
    const { presence, store, page, owner } = twoTabs();
    const written = deferred<undefined>();
    const storing = owner.store(async () => {
      await written.promise;
      store.session = 'new';
    });

    // When a page drops the old session and deletes the flag, then the owner's write lands
    await page.clear(() => {
      store.session = null;
      return Promise.resolve(true);
    });
    written.resolve(undefined);
    await storing;

    // Then the new sign-in stays and the flag is up
    expect(store.session).toBe('new');
    expect(presence.state).toBe('present');
  });
});

describe('the page role picks the flag keeper', () => {
  it('As an operator, I build the flag keeper for each page role and it raises the flag only in the sign-in window, a preview opened on its own and the landing page', async () => {
    for (const [role, raised] of [
      ['signin-window', true],
      ['preview', true],
      ['landing', true],
      ['signout-window', false],
      ['page', false],
      ['framed-preview', false],
    ] as [PageRole, boolean][]) {
      // Given the flag keeper for the role over an absent flag
      const presence = createFakeSessionPresence('absent');
      const flag = createPageSignInFlag({ role: () => role, presence, storedSignIn: () => Promise.resolve('held') });

      // When a sign-in is stored
      await flag.store(() => undefined);

      // Then the flag is up only for the roles that own it
      expect(presence.state === 'present').toBe(raised);
    }
  });
});

describe('renewing the flag', () => {
  it('As a page with any flag keeper, I renew the flag through the presence and never set it', () => {
    const storedSignIn = (): Promise<StoredSignIn> => Promise.resolve('held');
    for (const [keeper, build] of [
      ['page', presence => pageSignInFlag({ presence, storedSignIn })],
      ['owner', presence => ownerSignInFlag({ presence, storedSignIn })],
      ['page role page', presence => createPageSignInFlag({ role: () => 'page', presence, storedSignIn })],
      [
        'page role signin-window',
        presence => createPageSignInFlag({ role: () => 'signin-window', presence, storedSignIn }),
      ],
    ] as [string, (presence: FakeSessionPresence) => SignInFlag][]) {
      // Given the keeper over a set flag
      const presence = createFakeSessionPresence('present');
      const flag = build(presence);

      // When the flag is renewed
      flag.renew();

      // Then the presence was asked to renew once and never to set
      expect(presence.calls, keeper).toEqual(['renew']);
    }
  });
});
