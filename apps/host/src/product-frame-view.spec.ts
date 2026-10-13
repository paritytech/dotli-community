// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerAppRoot } from '@dotli/ui-core';
import { currentProductFrame, resetProductFrameLayout } from './product-frame-layout.js';
import { createProductFrameView } from './product-frame-view.js';

afterEach(() => {
  resetProductFrameLayout();
});

describe('product frame view', () => {
  /** `#app` holding stray error pages, and a body the view may write to. */
  function page(strays: { remove: () => void }[] = []): ReturnType<typeof createProductFrameView> {
    const container = { querySelectorAll: () => strays };
    return createProductFrameView({
      container: () => container as unknown as ParentNode,
      body: () => ({ style: {} }) as HTMLElement,
    });
  }

  it('As a dApp user, clearing for the frame takes down the page root and stray error pages, and the loading screen only when asked', () => {
    // Given
    const disposePage = vi.fn();
    const disposeLoading = vi.fn();
    const stray = { remove: vi.fn() };
    registerAppRoot('page', disposePage, vi.fn());
    registerAppRoot('loading', disposeLoading, vi.fn());
    const view = page([stray]);

    // When
    view.clearScreens({ loading: false });

    // Then
    expect(disposePage).toHaveBeenCalledTimes(1);
    expect(disposeLoading).not.toHaveBeenCalled();
    expect(stray.remove).toHaveBeenCalledTimes(1);

    // When
    view.clearScreens({ loading: true });

    // Then
    expect(disposeLoading).toHaveBeenCalledTimes(1);
  });

  it('As a dApp user, the frame I am handed is the one the layout owns', () => {
    // Given
    const view = page();
    const iframe = { isConnected: true, style: {} } as unknown as HTMLIFrameElement;

    // When
    view.attachFrame(iframe);

    // Then
    expect(currentProductFrame()).toBe(iframe);
  });
});
