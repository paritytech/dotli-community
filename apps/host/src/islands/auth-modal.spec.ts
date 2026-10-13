// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { createRoot, createSignal, flush } from 'solid-js';
import { createSyncStore } from '@dotli/shared';
import { closeWhenOpen, useRevealWhileOpen } from './auth-modal.js';

/** The island's reveal under a fresh owner, following `open` as the modal's state writes it. */
function mount(initiallyOpen: boolean) {
  const reveal = vi.fn();
  const [open, setOpen] = createSignal(initiallyOpen, { ownedWrite: true });
  const dispose = createRoot(d => {
    useRevealWhileOpen(open, reveal);
    return d;
  });
  flush();
  const write = (next: boolean): void => {
    setOpen(next);
    flush();
  };
  return { reveal, write, dispose };
}

describe('AuthModal island binding', () => {
  it('As a dApp user with the bar folded, a sign-in that opens brings the bar back each time it opens', () => {
    // Given
    const { reveal, write, dispose } = mount(false);

    // When: it opens, stays open, closes and opens again
    write(true);
    write(true);
    write(false);
    write(true);

    // Then
    expect(reveal).toHaveBeenCalledTimes(2);
    dispose();
  });

  it('As a dApp user, a sign-in still waiting behind another prompt leaves the bar alone', () => {
    // Given
    const { reveal, write, dispose } = mount(false);

    // When: the controller fills it in while it waits for the lease, so it stays closed
    write(false);

    // Then
    expect(reveal).not.toHaveBeenCalled();
    dispose();
  });

  it('As a user whose sign-in opened before the island hydrated, the bar comes back as it hydrates', () => {
    // Given a sign-in already open
    const opened = true;

    // When the island hydrates
    const { reveal, dispose } = mount(opened);

    // Then
    expect(reveal).toHaveBeenCalledTimes(1);
    dispose();
  });

  it('As the island, once disposed I no longer bring the bar back', () => {
    // Given
    const { reveal, write, dispose } = mount(false);

    // When
    dispose();
    write(true);

    // Then
    expect(reveal).not.toHaveBeenCalled();
  });

  it('As a user, closing an open sign-in closes it, and a close after the controller closed it does nothing', () => {
    // Given
    const modal = createSyncStore('auth-modal-binding-test', { open: true });
    const close = vi.fn();
    const onClose = closeWhenOpen(modal, close);

    // When
    onClose();

    // Then
    expect(close).toHaveBeenCalledTimes(1);

    // When: the login connected and the controller closed it
    modal.set({ open: false });
    onClose();

    // Then
    expect(close).toHaveBeenCalledTimes(1);
  });
});
