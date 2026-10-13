// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { resetAllStoresForTests } from '@dotli/shared/testing';
import { currentProductFrame } from './product-frame-layout.js';
import { createProductFrameView } from './product-frame-view.js';

afterEach(() => {
  resetAllStoresForTests();
});

describe('product frame view', () => {
  /** A body the view may write to, and the page's screen and loading screen as fakes. */
  function page(): {
    view: ReturnType<typeof createProductFrameView>;
    clearScreen: Mock;
    hideLoading: Mock;
    container: { dataset: DOMStringMap; replaceChildren: Mock };
  } {
    const clearScreen = vi.fn();
    const hideLoading = vi.fn();
    const container = { dataset: {} as DOMStringMap, replaceChildren: vi.fn() };
    const view = createProductFrameView({
      body: () => ({ style: {} }) as HTMLElement,
      container: () => container,
      clearScreen,
      hideLoading,
    });
    return { view, clearScreen, hideLoading, container };
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

  it('As a browser test, I read the frame status on its mount', () => {
    // Given
    const { view, container } = page();

    // When
    view.showStatus('connected');

    // Then
    expect(container.dataset['productFrame']).toBe('connected');
  });

  it('As a dApp user, I open a direct iframe app and its mount is emptied first', () => {
    // Given
    const { view, container } = page();

    // When
    view.clearMount();

    // Then
    expect(container.replaceChildren).toHaveBeenCalledTimes(1);
  });
});
