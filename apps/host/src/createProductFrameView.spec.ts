// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { resetAllStoresForTests } from '@dotli/shared/testing';
import { productFrameLayout } from './createProductFrameLayout.js';
import { createProductFrameView } from './createProductFrameView.js';

type ViewParams = Parameters<typeof createProductFrameView>[0];

afterEach(() => {
  resetAllStoresForTests();
});

describe('product frame view', () => {
  it('As a dApp user, I am handed a frame and it is the one the layout owns', () => {
    // Given
    const view = createProductFrameView(createViewParams({}));
    // The page's layout writes only the frame's style, and reads whether it is connected.
    const iframe = { isConnected: true, style: {} } as HTMLIFrameElement;

    // When
    view.attachFrame(iframe);

    // Then
    expect(productFrameLayout.getFrame()).toBe(iframe);
  });

  it.each([
    { loading: false, hidden: 0 },
    { loading: true, hidden: 1 },
  ])(
    'As a dApp user, I see the screens cleared and the loading screen ends only when the frame asks for it (loading $loading)',
    ({ loading, hidden }) => {
      // Given
      let screensCleared = 0;
      let loadingHidden = 0;
      const view = createProductFrameView(
        createViewParams({
          clearScreen() {
            screensCleared += 1;
          },
          hideLoading() {
            loadingHidden += 1;
          },
        }),
      );

      // When
      view.clearScreens({ loading });

      // Then
      expect(screensCleared).toBe(1);
      expect(loadingHidden).toBe(hidden);
    },
  );
});

/** Returns page parts that do nothing, apart from the ones a case passes. */
function createViewParams(parts: Partial<ViewParams>): ViewParams {
  return {
    // The view writes only the body's margin and overflow.
    body: () => ({ style: {} as CSSStyleDeclaration }),
    container: () => ({ dataset: {}, replaceChildren: () => undefined }),
    clearScreen: () => undefined,
    hideLoading: () => undefined,
    ...parts,
  };
}
