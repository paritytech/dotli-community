// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toastsStore, type ModalView, type ReportFailure } from '@dotli/ui-core';
import { FakePage } from '@dotli/shared/testing';
import { bindToastPage, modalsStore, resetModalsForTests, resetToastsForTests } from '@dotli/ui-core/testing';
import { createOverlays, type Overlays } from './load.js';

const report = vi.fn<ReportFailure>();

const VIEW: ModalView<'no' | 'yes' | 'dismissed'> = {
  title: 'Question',
  fields: [],
  buttons: [
    { label: 'No', variant: 'cancel', result: 'no' },
    { label: 'Yes', variant: 'primary', result: 'yes' },
  ],
  dismissOnBackdrop: true,
  dismissResult: 'dismissed',
  fallbackResult: 'dismissed',
};

/** Overlays whose chunk load is recorded and mounts at once, with an idle callback the test runs. */
function recordingOverlays(): { overlays: Overlays; load: ReturnType<typeof vi.fn>; idle: (() => void)[] } {
  const load = vi.fn((_onBroken: () => void) => Promise.resolve());
  const idle: (() => void)[] = [];
  const overlays = createOverlays({
    load,
    confirm: () => false,
    report,
    idle: {
      requestIdleCallback: run => idle.push(run),
      cancelIdleCallback: () => undefined,
    },
  });
  return { overlays, load, idle };
}

beforeEach(() => {
  bindToastPage(new FakePage());
});

afterEach(() => {
  resetModalsForTests();
  resetToastsForTests();
  report.mockReset();
});

describe('overlays loader', () => {
  it('As a dotli user, a toast pushed before the overlays mount is kept for them, and pushing it mounts them', async () => {
    // Given
    const { overlays, load } = recordingOverlays();

    // When
    overlays.presentToast({ text: 'Boot banner', label: 'Hello', icon: () => null, dismissMs: 0 });
    await overlays.ensure();

    // Then
    expect(toastsStore.get().items.map(t => t.label)).toEqual(['Hello']);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('As a dotli integrator, an aborted signal rejects before anything renders or loads', async () => {
    // Given
    const { overlays, load } = recordingOverlays();
    const controller = new AbortController();
    controller.abort();

    // When
    const outcome = overlays.presentModal(VIEW, controller.signal);

    // Then
    await expect(outcome).rejects.toMatchObject({ name: 'AbortError' });
    expect(load).not.toHaveBeenCalled();
    expect(modalsStore.get()).toEqual([]);
  });

  it('As a dotli integrator, aborting while the overlays are still loading never shows the dialog', async () => {
    // Given
    const { overlays } = recordingOverlays();
    const controller = new AbortController();
    const outcome = overlays.presentModal(VIEW, controller.signal);

    // When
    controller.abort();
    await overlays.ensure();

    // Then
    await expect(outcome).rejects.toMatchObject({ name: 'AbortError' });
    expect(modalsStore.get()).toEqual([]);
  });

  it('As a dotli user, prefetching mounts the overlays when the browser is idle', async () => {
    // Given
    const { overlays, load, idle } = recordingOverlays();

    // When
    overlays.prefetch();

    // Then
    expect(load).not.toHaveBeenCalled();

    // When
    for (const run of idle) {
      run();
    }
    await overlays.ensure();

    // Then
    expect(idle).toHaveLength(1);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('As a dotli user, the overlays keep the toast store in sync with what is shown', async () => {
    // Given
    const { overlays } = recordingOverlays();
    overlays.presentToast({ text: 'One', label: 'A', icon: () => null, dismissMs: 0 });

    // When
    await overlays.ensure();
    overlays.presentToast({ text: 'Two', label: 'B', icon: () => null, dismissMs: 0 });
    await overlays.ensure();

    // Then
    expect(toastsStore.get().items.map(t => t.label)).toEqual(['A', 'B']);
  });

  it('As a dotli user, when the overlay code cannot load, action toasts fall back to a confirm and dialogs settle with their fallback', async () => {
    // Given
    const confirm = vi.fn((_text: string) => true);
    const overlays = createOverlays({ load: () => Promise.reject(new Error('chunk failed')), confirm, report });
    const onClick = vi.fn();
    overlays.presentToast({
      text: 'A new version may have been deployed.',
      label: 'Asset failed to load',
      icon: () => null,
      dismissMs: 0,
      action: { label: 'Reload', onClick },
    });
    overlays.presentToast({
      text: 'Plain',
      label: 'Info',
      icon: () => null,
      dismissMs: 0,
    });
    const outcome = overlays.presentModal(VIEW);

    // When
    await overlays.ensure();

    // Then
    expect(report).toHaveBeenCalledWith(expect.any(Error), {
      flow: 'ui',
      step: 'root_load',
      tags: { root: 'overlays', kind: 'overlays_load_error' },
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith('Asset failed to load\n\nA new version may have been deployed.');
    expect(onClick).toHaveBeenCalledTimes(1);
    await expect(outcome).resolves.toEqual({ result: 'dismissed' });
    expect(toastsStore.get().items).toEqual([]);
  });
});
