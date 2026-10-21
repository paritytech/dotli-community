// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { createRoot, flush } from 'solid-js';
import type { RecentLabels } from '../recent-labels.js';
import { useActiveTld, useRecents } from './landing.js';

/**
 * A store holding `stored`, which counts how often the page opened it and what it was asked to forget. `loaded`
 * resolves after the reads so far have reached their readers.
 */
function memoryRecents(stored: string[]) {
  const opened = { count: 0 };
  const forgotten: string[] = [];
  const loads: Promise<string[]>[] = [];
  const recents: RecentLabels = {
    load: () => {
      const read = Promise.resolve([...stored]);
      loads.push(read);
      return read;
    },
    record: () => Promise.resolve(),
    forget: label => {
      forgotten.push(label);
      return Promise.resolve();
    },
  };
  const open = (): RecentLabels => {
    opened.count += 1;
    return recents;
  };
  return { open, opened, forgotten, loaded: () => Promise.all(loads) };
}

describe('useActiveTld', () => {
  it('As the name form, I have no TLD until settled in the browser, then the network one, read once', () => {
    // Given
    const read = vi.fn(() => '.dot');

    // When
    const { suffix, dispose } = createRoot(d => ({ suffix: useActiveTld(read), dispose: d }));

    // Then
    expect(suffix()).toBeNull();

    // When
    flush();

    // Then
    expect(suffix()).toBe('.dot');
    expect(read).toHaveBeenCalledTimes(1);
    dispose();
  });

  it('As a visitor on previewnet, the name form shows .testnet once boot has read my settings, even when it settled first', () => {
    // Given
    let tld = '.paseo';
    const listeners = new Set<() => void>();
    const subscribe = (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    };
    const { suffix, dispose } = createRoot(d => ({ suffix: useActiveTld(() => tld, subscribe), dispose: d }));
    flush();
    expect(suffix()).toBe('.paseo');

    // When
    tld = '.testnet';
    for (const listener of listeners) {
      listener();
    }
    flush();

    // Then
    expect(suffix()).toBe('.testnet');

    // When
    dispose();

    // Then
    expect(listeners.size).toBe(0);
  });
});

describe('useRecents', () => {
  it('As the recents list, I open the store once settled and show what it loads', async () => {
    // Given
    const store = memoryRecents(['alpha', 'beta']);

    // When
    const { recents, dispose } = createRoot(d => ({ recents: useRecents(store.open), dispose: d }));

    // Then
    expect(store.opened.count).toBe(0);
    expect(recents.labels()).toEqual([]);

    // When
    flush();

    // Then
    expect(store.opened.count).toBe(1);
    await store.loaded();
    flush();
    expect(recents.labels()).toEqual(['alpha', 'beta']);
    dispose();
  });

  it('As the recents list on a page inside another frame, I have no store and show none', () => {
    // Given
    const { recents, dispose } = createRoot(d => ({ recents: useRecents(() => undefined), dispose: d }));
    flush();

    // When
    recents.forget('alpha');
    flush();

    // Then
    expect(recents.labels()).toEqual([]);
    dispose();
  });

  it('As a visitor removing a recent, it leaves the list at once and the store forgets it', async () => {
    // Given
    const store = memoryRecents(['alpha', 'beta']);
    const { recents, dispose } = createRoot(d => ({ recents: useRecents(store.open), dispose: d }));
    flush();
    await store.loaded();
    flush();
    expect(recents.labels()).toEqual(['alpha', 'beta']);

    // When
    recents.forget('alpha');
    flush();

    // Then
    expect(recents.labels()).toEqual(['beta']);
    expect(store.forgotten).toEqual(['alpha']);
    dispose();
  });
});
