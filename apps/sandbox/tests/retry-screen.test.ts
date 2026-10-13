// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { clearScreen } from '@dotli/ui';
import { byTestId } from '@dotli/ui/testing';
import { showRetryScreen } from '../src/retry-screen.js';

afterEach(() => {
  clearScreen();
  document.body.replaceChildren();
});

describe('retry screen', () => {
  it('As a visitor whose app is starting again, I see the pulsing mark over what is happening', () => {
    // When
    showRetryScreen();

    // Then
    expect(byTestId('retry-screen-mark', document, SVGSVGElement).querySelectorAll('path')).toHaveLength(6);
    expect(byTestId('retry-screen').textContent).toBe("Retrying…The app's connection dropped, so it is starting again");
  });
});
