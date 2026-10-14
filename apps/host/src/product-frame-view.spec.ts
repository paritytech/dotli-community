// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { resetAllStoresForTests } from '@dotli/shared/testing';
import { currentProductFrame } from './product-frame-layout.js';
import { createProductFrameView } from './product-frame-view.js';

afterEach(() => {
  resetAllStoresForTests();
});

describe('product frame view', () => {
  it('As a dApp user, the frame I am handed is the one the layout owns', () => {
    // Given
    const view = createProductFrameView({
      body: () => ({ style: {} }) as HTMLElement,
      container: () => ({ dataset: {}, replaceChildren: () => undefined }),
      clearScreen: () => undefined,
      hideLoading: () => undefined,
    });
    const iframe = { isConnected: true, style: {} } as unknown as HTMLIFrameElement;

    // When
    view.attachFrame(iframe);

    // Then
    expect(currentProductFrame()).toBe(iframe);
  });

  it.each([
    { loading: false, hidden: 0 },
    { loading: true, hidden: 1 },
  ])(
    'As a dApp user, I see the loading screen end only when the frame asks for it (loading $loading)',
    ({ loading, hidden }) => {
      // Given
      let screensCleared = 0;
      let loadingHidden = 0;
      const view = createProductFrameView({
        body: () => ({ style: {} }) as HTMLElement,
        container: () => ({ dataset: {}, replaceChildren: () => undefined }),
        clearScreen: () => {
          screensCleared += 1;
        },
        hideLoading: () => {
          loadingHidden += 1;
        },
      });

      // When
      view.clearScreens({ loading });

      // Then
      expect(screensCleared).toBe(1);
      expect(loadingHidden).toBe(hidden);
    },
  );
});
