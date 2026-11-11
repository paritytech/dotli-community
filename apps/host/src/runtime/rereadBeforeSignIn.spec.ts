// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { atom, type WritableAtom } from 'nanostores';
import { recordLog } from '@dotli/shared/testing';
import type { AuthModalView } from '../state/authModalState.js';
import { rereadBeforeSignIn } from './rereadBeforeSignIn.js';
import type { DotliAuthState } from './session/types.js';

const UNREACHABLE_VIEW: AuthModalView = {
  kind: 'error',
  message: 'The saved session cannot be read',
  retry: true,
  pending: false,
  title: "Can't reach your saved sign-in",
  subtitle: 'dot.li could not check whether you are signed in. Try again in a moment.',
};

describe('rereadBeforeSignIn', () => {
  it('As a user whose saved sign-in still cannot be reached, I am told so and can try again', async () => {
    // Given
    const modal = createFakeModal();
    const auth = atom<DotliAuthState>({ tag: 'Unreachable' });
    const proceed = vi.fn<() => void>();

    // When
    await rereadBeforeSignIn({
      open: modal.open,
      modal,
      rereadSession: settleAs(auth, { tag: 'Unreachable' }),
      auth,
      proceed,
      elsewhere: () => false,
    });

    // Then
    expect(modal.shown.at(-1)).toEqual(UNREACHABLE_VIEW);
    expect(proceed).not.toHaveBeenCalled();
  });

  it('As a user on a page that pairs in place, I click and my sign-in goes on once my session reads signed out', async () => {
    // Given
    const modal = createFakeModal();
    const auth = atom<DotliAuthState>({ tag: 'Unreachable' });
    const proceed = vi.fn<() => void>();

    // When
    await rereadBeforeSignIn({
      open: modal.open,
      modal,
      rereadSession: settleAs(auth, { tag: 'Disconnected' }),
      auth,
      proceed,
      elsewhere: () => false,
    });

    // Then
    expect(proceed).toHaveBeenCalledOnce();
  });

  it('As a user on a product page, I click and am asked to continue once my session reads signed out', async () => {
    // Given
    const modal = createFakeModal();
    const auth = atom<DotliAuthState>({ tag: 'Unreachable' });

    // When
    await rereadBeforeSignIn({
      open: modal.open,
      modal,
      rereadSession: settleAs(auth, { tag: 'Disconnected' }),
      auth,
      proceed: null,
      elsewhere: () => true,
    });

    // Then
    expect(modal.shown.at(-1)).toEqual({ kind: 'prompt', resume: true });
  });

  it('As a user whose saved sign-in reads signed in, I click and nothing more is shown', async () => {
    // Given
    const modal = createFakeModal();
    const auth = atom<DotliAuthState>({ tag: 'Unreachable' });
    const proceed = vi.fn<() => void>();

    // When
    await rereadBeforeSignIn({
      open: modal.open,
      modal,
      rereadSession: settleAs(auth, { tag: 'Connected', session: { connected: true } }),
      auth,
      proceed,
      elsewhere: () => false,
    });

    // Then
    expect(modal.shown).toEqual([{ kind: 'spinner' }]);
    expect(proceed).not.toHaveBeenCalled();
  });

  it('As a user whose pairing started meanwhile, I click and nothing more is started', async () => {
    // Given
    const modal = createFakeModal();
    const auth = atom<DotliAuthState>({ tag: 'Unreachable' });
    const proceed = vi.fn<() => void>();

    // When
    await rereadBeforeSignIn({
      open: modal.open,
      modal,
      rereadSession: settleAs(auth, { tag: 'Pairing', deeplink: 'polkadotapp://pair', label: 'app' }),
      auth,
      proceed,
      elsewhere: () => false,
    });

    // Then
    expect(modal.shown).toEqual([{ kind: 'spinner' }]);
    expect(proceed).not.toHaveBeenCalled();
  });

  it('As a user who closes the dialog while the sign-in is read again, I see nothing more', async () => {
    // Given
    const modal = createFakeModal();
    const auth = atom<DotliAuthState>({ tag: 'Unreachable' });
    const proceed = vi.fn<() => void>();
    function closeWhileReading(): Promise<void> {
      modal.close();
      auth.set({ tag: 'Disconnected' });
      return Promise.resolve();
    }

    // When
    await rereadBeforeSignIn({
      open: modal.open,
      modal,
      rereadSession: closeWhileReading,
      auth,
      proceed,
      elsewhere: () => false,
    });

    // Then
    expect(modal.shown).toEqual([{ kind: 'spinner' }]);
    expect(proceed).not.toHaveBeenCalled();
  });

  it('As a user whose page failed to load its sign-in code, I click and am told the sign-in cannot be reached', async () => {
    // Given
    const logged = recordLog({ onFinished: onTestFinished, level: 'error' });
    const modal = createFakeModal();
    const auth = atom<DotliAuthState>({ tag: 'Unreachable' });
    function failToLoad(): Promise<void> {
      return Promise.reject(new Error('Failed to fetch dynamically imported module'));
    }

    // When
    await rereadBeforeSignIn({
      open: modal.open,
      modal,
      rereadSession: failToLoad,
      auth,
      proceed: null,
      elsewhere: () => false,
    });

    // Then
    expect(modal.shown.at(-1)).toEqual(UNREACHABLE_VIEW);
    expect(logged).toHaveLength(1);
  });

  it('As a user whose dialog cannot open, I click and nothing is read', async () => {
    // Given
    const modal = createFakeModal();
    const auth = atom<DotliAuthState>({ tag: 'Unreachable' });
    const rereadSession = vi.fn<() => Promise<void>>(async () => {});

    // When
    await rereadBeforeSignIn({
      open: () => false,
      modal,
      rereadSession,
      auth,
      proceed: null,
      elsewhere: () => false,
    });

    // Then
    expect(rereadSession).not.toHaveBeenCalled();
  });
});

/** A modal that records each view it shows and holds a fresh lease from each open until it closes. */
function createFakeModal() {
  const shown: AuthModalView[] = [];
  let lease: object | null = null;

  function open(): boolean {
    lease = {};
    return true;
  }
  function close(): void {
    lease = null;
  }
  function getLease(): object | null {
    return lease;
  }
  function show(view: AuthModalView): void {
    shown.push(view);
  }

  return { shown, open, close, getLease, show };
}

/** A re-read that shows `settled` on the page and then resolves. */
function settleAs(auth: WritableAtom<DotliAuthState>, settled: DotliAuthState): () => Promise<void> {
  function rereadSession(): Promise<void> {
    auth.set(settled);
    return Promise.resolve();
  }
  return rereadSession;
}
