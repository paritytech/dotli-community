// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetAllStoresForTests } from '@dotli/shared/testing';
import { createDebugPanelHost } from './debugPanelHost.js';
import { createProductFrameLayout } from './createProductFrameLayout.js';
import type { FrameBox } from './getFrameBox.js';
import { createFakeIframe } from './runtime/createProductFrame.fake.js';

afterEach(() => {
  resetAllStoresForTests();
});

describe('the debug panel host', () => {
  it("As a dotli developer, I dock the debug panel and its room sits beside the sandbox checker's at the bottom edge, not over it", () => {
    // Given a frame on the page and the checker docked below it
    const apply = vi.fn<(frame: HTMLIFrameElement, box: FrameBox) => void>();
    const layout = createProductFrameLayout({ apply });
    layout.attach(createFakeIframe());
    layout.setDockInset({ right: 0, bottom: 100 }, 'sandbox-checker');
    const host = createDebugPanelHost({ layout });

    // When
    host.reportDockInset({ right: 0, bottom: 360 });

    // Then
    expect(apply.mock.lastCall?.[1].bottom).toBe(460);
  });
});
