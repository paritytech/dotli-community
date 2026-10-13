// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { currentProductFrame, resetProductFrameLayout } from './product-frame-layout.js';
import { createProductFrameView } from './product-frame-view.js';

afterEach(() => {
  resetProductFrameLayout();
});

describe('product frame view', () => {
  /** A body the view may write to, and the page's screen and loading screen as fakes. */
  function page(): { view: ReturnType<typeof createProductFrameView>; clearScreen: Mock; hideLoading: Mock } {
    const clearScreen = vi.fn();
    const hideLoading = vi.fn();
    const view = createProductFrameView({
      body: () => ({ style: {} }) as HTMLElement,
      clearScreen,
      hideLoading,
    });
    return { view, clearScreen, hideLoading };
  }

  it('As a dApp user, clearing for the frame takes the shown screen down, and the loading screen only when asked', () => {
    // Given
    const { view, clearScreen, hideLoading } = page();

    // When
    view.clearScreens({ loading: false });

    // Then
    expect(clearScreen).toHaveBeenCalledTimes(1);
    expect(hideLoading).not.toHaveBeenCalled();

    // When
    view.clearScreens({ loading: true });

    // Then
    expect(clearScreen).toHaveBeenCalledTimes(2);
    expect(hideLoading).toHaveBeenCalledTimes(1);
  });

  it('As a dApp user, the frame I am handed is the one the layout owns', () => {
    // Given
    const { view } = page();
    const iframe = { isConnected: true, style: {} } as unknown as HTMLIFrameElement;

    // When
    view.attachFrame(iframe);

    // Then
    expect(currentProductFrame()).toBe(iframe);
  });
});
