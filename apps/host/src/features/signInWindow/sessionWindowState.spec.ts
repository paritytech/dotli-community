// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { atom } from 'nanostores';
import { resetAllStoresForTests } from '@dotli/shared/testing';
import { sessionWindowState, type WindowScreen } from './sessionWindowState.js';

const CONNECTING: WindowScreen = { view: 'connecting', pageHost: null, failure: null, pairing: { kind: 'spinner' } };

afterEach(() => {
  resetAllStoresForTests();
});

describe('session window state', () => {
  it('As the session window, I show a screen source and read its latest screen at once after it changes', () => {
    // Given a source whose earlier listener moves it on from a sign-out to its end, then shown
    const source = atom<WindowScreen>(CONNECTING);
    onTestFinished(
      source.listen(screen => {
        if (screen.view === 'signing-out') {
          source.set({ view: 'signed-out' });
        }
      }),
    );
    onTestFinished(sessionWindowState.showScreen(source));

    // When
    source.set({ view: 'signing-out' });

    // Then
    expect(sessionWindowState.store.get()).toEqual({ view: 'signed-out' });
  });
});
