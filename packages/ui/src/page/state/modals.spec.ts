// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { modalsStore, openModal, refuseModals, settleModal, type ModalHandoff, type ModalView } from './modals.js';
import { nth, recordLog, resetAllStoresForTests } from '@dotli/shared/testing';
import { spans as S } from '@dotli/metrics';
import { bindRecordingSentry, recordCaptures } from '@dotli/metrics/testing';

type Choice = 'yes' | 'no' | 'dismissed';

function view(title: string): ModalView<Choice> {
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

afterEach(() => {
  resetAllStoresForTests();
});

describe('modal store', () => {
  it('As a dotli integrator, an opened modal is queued in order and resolves with the chosen result', async () => {
    // Given
    const first = openModal(view('First'));
    const second = openModal(view('Second'));
    const entries = modalsStore.get();
    const a = nth(entries, 0);
    const b = nth(entries, 1);

    // Then
    expect(modalsStore.get().map(e => e.view.title)).toEqual(['First', 'Second']);

    // When
    settleModal(a.id, 'yes');

    // Then
    await expect(first).resolves.toEqual({ result: 'yes' });
    expect(modalsStore.get().map(e => e.id)).toEqual([b.id]);

    // When
    settleModal(b.id, 'no', 'typed');

    // Then
    await expect(second).resolves.toEqual({ result: 'no', value: 'typed' });
    expect(modalsStore.get()).toEqual([]);
  });

  it('As a dotli integrator, a modal settles only once', async () => {
    // Given
    const outcome = openModal(view('Once'));
    const entry = nth(modalsStore.get(), 0);

    // When
    settleModal(entry.id, 'yes');
    settleModal(entry.id, 'no');

    // Then
    await expect(outcome).resolves.toEqual({ result: 'yes' });
  });

  it('As a dotli integrator, an already aborted signal rejects without queueing anything', async () => {
    // Given
    const controller = new AbortController();
    controller.abort('gone');

    // When
    const outcome = openModal(view('Aborted'), controller.signal);

    // Then
    await expect(outcome).rejects.toMatchObject({ name: 'AbortError' });
    expect(modalsStore.get()).toEqual([]);
  });

  it('As a dotli integrator, aborting an open modal removes it and rejects with AbortError', async () => {
    // Given
    const controller = new AbortController();
    const outcome = openModal(view('Open'), controller.signal);

    // When
    controller.abort();

    // Then
    await expect(outcome).rejects.toMatchObject({ name: 'AbortError' });
    expect(modalsStore.get()).toEqual([]);
  });
});

describe('dialogs that cannot be shown', () => {
  it('As a product, a request waiting on overlays that cannot render is refused at once', async () => {
    // Given
    const asked = openModal({
      title: 'Allow camera?',
      fields: [],
      buttons: [
        { label: 'Deny', variant: 'danger', result: 'deny' },
        { label: 'Allow', variant: 'primary', result: 'allow' },
      ],
      dismissOnBackdrop: false,
    });

    // When
    onTestFinished(refuseModals());

    // Then
    await expect(asked).resolves.toEqual({ result: 'deny' });
  });

  it('As a product, a request made after the overlays broke is refused too, with its dismiss answer', async () => {
    // Given
    onTestFinished(refuseModals());

    // When
    const asked = openModal({
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

  it('As a product, once the refusal stops, a new request waits for an answer again', () => {
    // Given
    const stop = refuseModals();
    stop();

    // When
    void openModal({
      title: 'Sign',
      fields: [],
      buttons: [{ label: 'Cancel', variant: 'cancel', result: 'cancel' }],
      dismissOnBackdrop: false,
    });

    // Then
    expect(modalsStore.get()).toHaveLength(1);
  });
});

describe('a dialog that hands its place to a second view', () => {
  const next = (signal: AbortSignal, closed: (result: string) => void): ModalHandoff => ({
    view: {
      title: 'Waiting',
      fields: [],
      buttons: [{ label: 'Wait in background', variant: 'secondary', result: 'background' }],
      dismissOnBackdrop: true,
      dismissResult: 'background',
    },
    signal,
    closed,
  });

  it('As a product, I get my answer while the dialog hands its place to the next view', async () => {
    // Given
    const asked = openModal(view('Review'), undefined, () => next(new AbortController().signal, () => undefined));
    const before = nth(modalsStore.get(), 0);

    // When
    settleModal(before.id, 'yes');

    // Then
    await expect(asked).resolves.toEqual({ result: 'yes' });
    expect(modalsStore.get()).toHaveLength(1);
    const after = nth(modalsStore.get(), 0);
    expect(after.id).toBe(before.id);
    expect(after.view.title).toBe('Waiting');
  });

  it('As a user, I close the handed-off view with its button and the caller hears which', () => {
    // Given
    const closed = vi.fn();
    void openModal(view('Review'), undefined, () => next(new AbortController().signal, closed));
    settleModal(nth(modalsStore.get(), 0).id, 'yes');

    // When
    settleModal(nth(modalsStore.get(), 0).id, 'background');

    // Then
    expect(closed).toHaveBeenCalledExactlyOnceWith('background');
    expect(modalsStore.get()).toEqual([]);
  });

  it('As a host, I close the handed-off view from elsewhere', () => {
    // Given
    const closed = vi.fn();
    const controller = new AbortController();
    void openModal(view('Review'), undefined, () => next(controller.signal, closed));
    settleModal(nth(modalsStore.get(), 0).id, 'yes');

    // When
    controller.abort();

    // Then
    expect(closed).toHaveBeenCalledExactlyOnceWith('aborted');
    expect(modalsStore.get()).toEqual([]);
  });

  it('As a host, a handoff that returns nothing closes the dialog as before', async () => {
    // Given
    const asked = openModal(view('Review'), undefined, () => undefined);

    // When
    settleModal(nth(modalsStore.get(), 0).id, 'yes');

    // Then
    await expect(asked).resolves.toEqual({ result: 'yes' });
    expect(modalsStore.get()).toEqual([]);
  });

  it('As a host, an aborted handoff signal never shows the view', () => {
    // Given
    const closed = vi.fn();
    const controller = new AbortController();
    controller.abort();
    void openModal(view('Review'), undefined, () => next(controller.signal, closed));

    // When
    settleModal(nth(modalsStore.get(), 0).id, 'yes');

    // Then
    expect(modalsStore.get()).toEqual([]);
    expect(closed).toHaveBeenCalledExactlyOnceWith('aborted');
  });

  it('As a product, aborting my signal after the answer leaves the next step open', async () => {
    // Given
    const closed = vi.fn();
    const mine = new AbortController();
    const asked = openModal(view('Review'), mine.signal, () => next(new AbortController().signal, closed));
    settleModal(nth(modalsStore.get(), 0).id, 'yes');
    await asked;

    // When
    mine.abort();

    // Then
    expect(modalsStore.get()).toHaveLength(1);
    expect(closed).not.toHaveBeenCalled();
  });

  it('As a host, the handoff hears the answer and closes the dialog for a refusal', async () => {
    // Given
    const closed = vi.fn();
    const handoff = (outcome: { result: Choice }): ModalHandoff | undefined =>
      outcome.result === 'yes' ? next(new AbortController().signal, closed) : undefined;
    const refused = openModal(view('Refused'), undefined, handoff);
    const accepted = openModal(view('Accepted'), undefined, handoff);

    // When
    settleModal(nth(modalsStore.get(), 0).id, 'no');
    settleModal(nth(modalsStore.get(), 0).id, 'yes');

    // Then
    await expect(refused).resolves.toEqual({ result: 'no' });
    await expect(accepted).resolves.toEqual({ result: 'yes' });
    expect(modalsStore.get().map(e => e.view.title)).toEqual(['Waiting']);
  });

  it('As a product, I still get my answer when the handoff throws, and the failure is reported', async () => {
    // Given
    const captured = recordCaptures({ onFinished: onTestFinished });
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    const logged = recordLog({ onFinished: onTestFinished, level: 'error' });
    const asked = openModal(view('Review'), undefined, () => {
      throw new TypeError('boom');
    });

    // When
    settleModal(nth(modalsStore.get(), 0).id, 'yes');

    // Then
    await expect(asked).resolves.toEqual({ result: 'yes' });
    expect(modalsStore.get()).toEqual([]);
    expect(captured.map(c => c.step)).toEqual(['modal_handoff']);
    expect(logged).toHaveLength(1);
    expect(sentry.counted(S.MODAL_HANDOFF)).toEqual([{ outcome: 'error', reason: 'TypeError' }]);
  });

  it('As a page whose overlays broke, refuseModals answers a handed-off view with its dismiss result', () => {
    // Given
    const closed = vi.fn();
    void openModal(view('Review'), undefined, () => next(new AbortController().signal, closed));
    settleModal(nth(modalsStore.get(), 0).id, 'yes');

    // When
    onTestFinished(refuseModals());

    // Then
    expect(closed).toHaveBeenCalledExactlyOnceWith('background');
    expect(modalsStore.get()).toEqual([]);
  });
});
