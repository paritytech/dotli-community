// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SITE_ID } from '@dotli/config';

const protocol = vi.hoisted(() => ({
  requestLocalWalletOwner: vi.fn(),
  subscribeLocalWalletChanged: vi.fn(),
  subscribeLocalWalletOwnerRevoked: vi.fn(),
}));
vi.mock('@dotli/protocol', () => protocol);

const overlays = vi.hoisted(() => ({ ensureOverlays: vi.fn(() => Promise.resolve()) }));
vi.mock('../src/overlays/load.js', () => overlays);

import { walletPauseStore, resetWalletPauseForTests } from '../src/state/wallet-pause.js';
import {
  acquireLocalWalletOwner,
  onNextInteraction,
  resetWalletHandoverForTests,
  watchLocalWalletChanges,
} from '../src/wallet-handover.js';

/** The revocation listener the handover bound on its first acquire. */
function revocation(): (lease: string | undefined) => void {
  const listener = protocol.subscribeLocalWalletOwnerRevoked.mock.calls[0]?.[0] as
    ((lease: string | undefined) => void) | undefined;
  if (listener === undefined) {
    throw new Error('no revocation listener bound');
  }
  return listener;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetWalletHandoverForTests();
  resetWalletPauseForTests();
  protocol.requestLocalWalletOwner.mockImplementation((_site: string, operation: { action: string }) =>
    Promise.resolve(operation.action === 'acquire' ? 'lease-1' : undefined),
  );
});

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('local wallet handover', () => {
  it('As the first tab, I take the wallet once and reuse my lease', async () => {
    // When
    await acquireLocalWalletOwner();
    await acquireLocalWalletOwner();

    // Then
    expect(protocol.requestLocalWalletOwner).toHaveBeenCalledOnce();
    expect(protocol.requestLocalWalletOwner).toHaveBeenCalledWith(SITE_ID, { action: 'acquire' });
    expect(walletPauseStore.get().reason).toBeNull();
  });

  it('As the tab another tab took the wallet from, I pause, then release my lease', async () => {
    // Given
    await acquireLocalWalletOwner();
    const order: string[] = [];
    walletPauseStore.subscribe(() => order.push(`pause:${String(walletPauseStore.get().reason)}`));
    protocol.requestLocalWalletOwner.mockImplementation((_site: string, operation: { action: string }) => {
      order.push(operation.action);
      return Promise.resolve(undefined);
    });

    // When
    revocation()('lease-1');

    // Then
    expect(order).toEqual(['pause:moved', 'release']);
    expect(protocol.requestLocalWalletOwner).toHaveBeenLastCalledWith(SITE_ID, { action: 'release', lease: 'lease-1' });
    expect(overlays.ensureOverlays).toHaveBeenCalled();
    await expect(acquireLocalWalletOwner()).rejects.toThrow(/paused/);
  });

  it('As a tab whose protocol frame went away, I pause without releasing a lease I no longer hold', async () => {
    // Given
    await acquireLocalWalletOwner();
    protocol.requestLocalWalletOwner.mockClear();

    // When
    revocation()(undefined);

    // Then
    expect(walletPauseStore.get().reason).toBe('lost');
    expect(protocol.requestLocalWalletOwner).not.toHaveBeenCalled();
  });

  it('As a tab that never took the wallet, I ignore revocations', async () => {
    // Given: bound by an acquire that failed
    protocol.requestLocalWalletOwner.mockRejectedValueOnce(new Error('busy'));
    await expect(acquireLocalWalletOwner()).rejects.toThrow('busy');

    // When
    revocation()(undefined);

    // Then
    expect(walletPauseStore.get().reason).toBeNull();
  });

  it('As a tab hearing that a sibling changed the wallet, I pause and keep my lease until it is asked for', async () => {
    // Given
    await acquireLocalWalletOwner();
    watchLocalWalletChanges();
    const changed = protocol.subscribeLocalWalletChanged.mock.calls[0]?.[0] as () => void;
    protocol.requestLocalWalletOwner.mockClear();

    // When
    changed();

    // Then
    expect(walletPauseStore.get().reason).toBe('changed');
    expect(protocol.requestLocalWalletOwner).not.toHaveBeenCalled();

    // When the reloaded sibling asks for the wallet
    revocation()('lease-1');

    // Then
    expect(walletPauseStore.get().reason).toBe('changed');
    expect(protocol.requestLocalWalletOwner).toHaveBeenCalledWith(SITE_ID, { action: 'release', lease: 'lease-1' });
  });
});

describe('resuming a paused tab', () => {
  it('resumes once on the first click or key press in the shell', () => {
    const resume = vi.fn();
    onNextInteraction(resume);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    window.dispatchEvent(new PointerEvent('pointerdown'));

    expect(resume).toHaveBeenCalledOnce();
  });

  it('resumes when focus moves into the app frame', () => {
    vi.useFakeTimers();
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const resume = vi.fn();
    onNextInteraction(resume);

    frame.focus();
    window.dispatchEvent(new Event('blur'));
    vi.runAllTimers();

    expect(resume).toHaveBeenCalledOnce();
  });

  it('ignores the window losing focus to another tab', () => {
    vi.useFakeTimers();
    const resume = vi.fn();
    onNextInteraction(resume);

    window.dispatchEvent(new Event('blur'));
    vi.runAllTimers();

    expect(resume).not.toHaveBeenCalled();
  });
});
