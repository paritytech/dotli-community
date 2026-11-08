// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createModals, type ModalHandoff, type ModalView } from './createModals.js';
import { catchError, nth, recordLog, resetAllStoresForTests } from '@dotli/shared/testing';
import { bindRecordingSentry, recordReports } from '@dotli/metrics/testing';

type Choice = 'yes' | 'no' | 'dismissed';

let modals: ReturnType<typeof createModals>;

function buildView(title: string): ModalView<Choice> {
  return {
    title,
    fields: [],
    buttons: [
      { label: 'No', variant: 'cancel', result: 'no' },
      { label: 'Yes', variant: 'primary', result: 'yes' },
    ],
    dismissOnBackdrop: true,
    dismissResult: 'dismissed',
  };
}

/** The view a dialog hands its place to, closed by `signal` and telling `closed` how it closed. */
function buildHandoff(signal: AbortSignal, closed: (result: string) => void): ModalHandoff {
  return {
    view: {
      title: 'Waiting',
      fields: [],
      buttons: [{ label: 'Wait in background', variant: 'secondary', result: 'background' }],
      dismissOnBackdrop: true,
      dismissResult: 'background',
    },
    signal,
    closed,
  };
}

function readFirstId(): number {
  return nth(modals.store.get(), 0).id;
}

beforeEach(() => {
  modals = createModals();
});

afterEach(() => {
  resetAllStoresForTests();
});

describe('modal store', () => {
  it('As a dotli integrator, I open modals and they queue in order and resolve with the chosen result', async () => {
    // Given
    const first = modals.open(buildView('First'));
    const second = modals.open(buildView('Second'));
    const firstEntry = nth(modals.store.get(), 0);
    const secondEntry = nth(modals.store.get(), 1);
    const queued = modals.store.get().map(entry => entry.view.title);

    // When
    modals.settle(firstEntry.id, 'yes');
    const afterFirst = modals.store.get().map(entry => entry.id);
    modals.settle(secondEntry.id, 'no', { value: 'typed' });

    // Then
    expect(queued).toEqual(['First', 'Second']);
    await expect(first).resolves.toEqual({ result: 'yes' });
    expect(afterFirst).toEqual([secondEntry.id]);
    await expect(second).resolves.toEqual({ result: 'no', value: 'typed' });
    expect(modals.store.get()).toEqual([]);
  });

  it('As a dotli integrator, I settle a modal twice and only the first answer counts', async () => {
    // Given
    const outcome = modals.open(buildView('Once'));
    const entry = nth(modals.store.get(), 0);

    // When
    modals.settle(entry.id, 'yes');
    modals.settle(entry.id, 'no');

    // Then
    await expect(outcome).resolves.toEqual({ result: 'yes' });
  });

  it('As a dotli integrator, I open a modal with an aborted signal and it rejects without queueing anything', async () => {
    // Given
    const controller = new AbortController();
    controller.abort('gone');

    // When
    const outcome = modals.open(buildView('Aborted'), { signal: controller.signal });

    // Then
    await expect(outcome).rejects.toMatchObject({ name: 'AbortError' });
    expect(modals.store.get()).toEqual([]);
  });

  it('As a dotli integrator, I abort an open modal and it leaves the queue and rejects with AbortError', async () => {
    // Given
    const controller = new AbortController();
    const outcome = modals.open(buildView('Open'), { signal: controller.signal });

    // When
    controller.abort();

    // Then
    await expect(outcome).rejects.toMatchObject({ name: 'AbortError' });
    expect(modals.store.get()).toEqual([]);
  });
});

describe('dialogs that cannot be shown', () => {
  it('As a product, I wait on overlays that cannot render and my request is refused at once', async () => {
    // Given
    const asked = modals.open({
      title: 'Allow camera?',
      fields: [],
      buttons: [
        { label: 'Deny', variant: 'danger', result: 'deny' },
        { label: 'Allow', variant: 'primary', result: 'allow' },
      ],
      dismissOnBackdrop: false,
    });

    // When
    onTestFinished(modals.refuseAll());

    // Then
    await expect(asked).resolves.toEqual({ result: 'deny' });
  });

  it('As a product, I ask after the overlays broke and my request is refused too, with its dismiss answer', async () => {
    // Given
    onTestFinished(modals.refuseAll());

    // When
    const asked = modals.open({
      title: 'Submit Preimage',
      fields: [],
      buttons: [
        { label: 'Cancel', variant: 'cancel', result: 'cancel' },
        { label: 'Allow', variant: 'primary', result: 'allow' },
      ],
      dismissOnBackdrop: true,
      dismissResult: 'cancel',
    });

    // Then
    await expect(asked).resolves.toEqual({ result: 'cancel' });
  });

  it('As a page, I refuse all open dialogs while another opens, and every dialog settles with its refusal', async () => {
    // Given
    const first = modals.open(buildView('First'));
    const second = modals.open(buildView('Second'));
    const stop = modals.refuseAll();
    onTestFinished(stop);

    // When
    const third = modals.open(buildView('Third'));

    // Then
    expect(modals.store.get()).toEqual([]);
    await expect(first).resolves.toEqual({ result: 'dismissed' });
    await expect(second).resolves.toEqual({ result: 'dismissed' });
    await expect(third).resolves.toEqual({ result: 'dismissed' });
  });

  it('As a product, I ask once the refusal stops and my request waits for an answer again', () => {
    // Given
    const stop = modals.refuseAll();
    stop();

    // When
    void modals.open({
      title: 'Sign',
      fields: [],
      buttons: [{ label: 'Cancel', variant: 'cancel', result: 'cancel' }],
      dismissOnBackdrop: false,
    });

    // Then
    expect(modals.store.get()).toHaveLength(1);
  });
});

describe('a page that refuses twice', () => {
  it('As a page, I call refuseAll twice and one listener refuses each new dialog, and both stops end it', async () => {
    // Given
    const stopFirst = modals.refuseAll();
    const stopSecond = modals.refuseAll();
    const listeners = modals.store.lc;

    // When
    stopFirst();
    const afterFirstStop = modals.store.lc;
    const askedAfterFirst = modals.open(buildView('After first'));
    stopSecond();
    void modals.open(buildView('After second'));

    // Then
    expect(listeners).toBe(1);
    expect(afterFirstStop).toBe(1);
    await expect(askedAfterFirst).resolves.toEqual({ result: 'dismissed' });
    expect(modals.store.lc).toBe(0);
    expect(modals.store.get()).toHaveLength(1);
  });
});

describe('a dialog that hands its place to a second view', () => {
  it('As a product, I get my answer and the dialog hands its place to the next view', async () => {
    // Given
    const asked = modals.open(buildView('Review'), {
      handoff: () => buildHandoff(new AbortController().signal, () => undefined),
    });
    const before = nth(modals.store.get(), 0);

    // When
    modals.settle(before.id, 'yes');

    // Then
    await expect(asked).resolves.toEqual({ result: 'yes' });
    expect(modals.store.get()).toHaveLength(1);
    const after = nth(modals.store.get(), 0);
    expect(after.id).toBe(before.id);
    expect(after.view.title).toBe('Waiting');
  });

  it('As a user, I close the handed-off view with its button and the caller hears which', () => {
    // Given
    const closed = vi.fn();
    void modals.open(buildView('Review'), { handoff: () => buildHandoff(new AbortController().signal, closed) });
    modals.settle(readFirstId(), 'yes');

    // When
    modals.settle(readFirstId(), 'background');

    // Then
    expect(closed).toHaveBeenCalledExactlyOnceWith('background');
    expect(modals.store.get()).toEqual([]);
  });

  it('As a host, I close the handed-off view from elsewhere and the dialog leaves', () => {
    // Given
    const closed = vi.fn();
    const controller = new AbortController();
    void modals.open(buildView('Review'), { handoff: () => buildHandoff(controller.signal, closed) });
    modals.settle(readFirstId(), 'yes');

    // When
    controller.abort();

    // Then
    expect(closed).toHaveBeenCalledExactlyOnceWith('aborted');
    expect(modals.store.get()).toEqual([]);
  });

  it('As a host, I hand off to no view and the dialog closes as before', async () => {
    // Given
    const asked = modals.open(buildView('Review'), { handoff: () => undefined });

    // When
    modals.settle(readFirstId(), 'yes');

    // Then
    await expect(asked).resolves.toEqual({ result: 'yes' });
    expect(modals.store.get()).toEqual([]);
  });

  it('As a host, I hand off on an aborted signal and the view never shows', () => {
    // Given
    const closed = vi.fn();
    const controller = new AbortController();
    controller.abort();
    void modals.open(buildView('Review'), { handoff: () => buildHandoff(controller.signal, closed) });

    // When
    modals.settle(readFirstId(), 'yes');

    // Then
    expect(modals.store.get()).toEqual([]);
    expect(closed).toHaveBeenCalledExactlyOnceWith('aborted');
  });

  it('As a product, I abort my signal after the answer and the next step stays open', async () => {
    // Given
    const closed = vi.fn();
    const mine = new AbortController();
    const asked = modals.open(buildView('Review'), {
      signal: mine.signal,
      handoff: () => buildHandoff(new AbortController().signal, closed),
    });
    modals.settle(readFirstId(), 'yes');
    await asked;

    // When
    mine.abort();

    // Then
    expect(modals.store.get()).toHaveLength(1);
    expect(closed).not.toHaveBeenCalled();
  });

  it('As a host, I hear the answer in the handoff and close the dialog for a refusal', async () => {
    // Given
    const closed = vi.fn();
    const handoff = (outcome: { result: Choice }): ModalHandoff | undefined =>
      outcome.result === 'yes' ? buildHandoff(new AbortController().signal, closed) : undefined;
    const refused = modals.open(buildView('Refused'), { handoff });
    const accepted = modals.open(buildView('Accepted'), { handoff });

    // When
    modals.settle(readFirstId(), 'no');
    modals.settle(readFirstId(), 'yes');

    // Then
    await expect(refused).resolves.toEqual({ result: 'no' });
    await expect(accepted).resolves.toEqual({ result: 'yes' });
    expect(modals.store.get().map(entry => entry.view.title)).toEqual(['Waiting']);
  });

  it('As a product, I still get my answer when the handoff throws, and the failure is reported', async () => {
    // Given
    const captured = recordReports({ onFinished: onTestFinished }).exceptions;
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    const logged = recordLog({ onFinished: onTestFinished, level: 'error' });
    const asked = modals.open(buildView('Review'), {
      handoff: () => {
        throw new TypeError('boom');
      },
    });

    // When
    modals.settle(readFirstId(), 'yes');

    // Then
    await expect(asked).resolves.toEqual({ result: 'yes' });
    expect(modals.store.get()).toEqual([]);
    expect(captured.map(capture => capture.step)).toEqual(['modal_handoff']);
    expect(logged).toHaveLength(1);
    expect(sentry.counted('modal.handoff')).toEqual([{ outcome: 'error', reason: 'TypeError' }]);
  });

  it('As a page whose overlays broke, I refuse every dialog and a handed-off view gets its dismiss result', () => {
    // Given
    const closed = vi.fn();
    void modals.open(buildView('Review'), { handoff: () => buildHandoff(new AbortController().signal, closed) });
    modals.settle(readFirstId(), 'yes');

    // When
    onTestFinished(modals.refuseAll());

    // Then
    expect(closed).toHaveBeenCalledExactlyOnceWith('background');
    expect(modals.store.get()).toEqual([]);
  });
});

describe('a dialog queue that is disposed', () => {
  it('As a page that ends, I dispose the dialog queue and an open dialog stops listening to its signal', async () => {
    // Given an open dialog bound to a caller's abort signal
    const controller = new AbortController();
    const removed = vi.spyOn(controller.signal, 'removeEventListener');
    const answer = modals.open(buildView('Review'), { signal: controller.signal });

    // When the queue is disposed twice
    modals.dispose();
    modals.dispose();

    // Then the signal listener is removed, the queue is empty and the dialog rejected
    expect(removed).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(modals.store.get()).toEqual([]);
    await expect(answer).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('As a page that ends, I dispose the dialog queue and an open dialog rejects with an AbortError', async () => {
    // Given an open dialog with no signal
    const answer = modals.open(buildView('Review'));

    // When the queue is disposed
    modals.dispose();

    // Then the dialog rejects with an AbortError that names the disposed scope
    await expect(answer).rejects.toMatchObject({ name: 'AbortError', message: 'Blocking modal scope disposed' });
  });

  it('As a host whose handed-off view fails as the queue is disposed, I still see every open dialog reject', async () => {
    // Given a dialog handed off to a view whose closed throws, then a second open dialog
    const viewBug = new Error('view bug');
    void modals.open(buildView('First'), {
      handoff: () =>
        buildHandoff(new AbortController().signal, () => {
          throw viewBug;
        }),
    });
    modals.settle(readFirstId(), 'yes');
    const answer = modals.open(buildView('Second'));

    // When the queue is disposed
    const thrown = catchError(() => {
      modals.dispose();
    });

    // Then the view's error propagates and the open dialog rejected with an AbortError
    expect(thrown).toBe(viewBug);
    await expect(answer).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('As a host, I dispose the dialog queue while a handed-off view is open and it hears that it was aborted, once', () => {
    // Given a dialog handed off to the host and still open there
    const closed = vi.fn();
    void modals.open(buildView('Review'), { handoff: () => buildHandoff(new AbortController().signal, closed) });
    modals.settle(readFirstId(), 'yes');

    // When the queue is disposed twice
    modals.dispose();
    modals.dispose();

    // Then the host hears the abort once and the queue is empty
    expect(closed).toHaveBeenCalledExactlyOnceWith('aborted');
    expect(modals.store.get()).toEqual([]);
  });
});
