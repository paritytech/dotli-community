// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetAllStoresForTests } from '@dotli/shared/testing';
import { archiveTransport, debugPanelHost } from './debug-panel-host.js';
import { attachProductFrame, setDockInset, type ApplyFrameBox } from './product-frame-layout.js';
import { fakeIframe } from './runtime/product-frame.fake.js';

afterEach(() => {
  resetAllStoresForTests();
});

describe('the debug panel host', () => {
  it("As a dotli developer on the light client, the Archive tab reads blocks from the host's sandbox relay", () => {
    // Given
    const blockSource = vi.fn(() => Promise.resolve(new Uint8Array()));

    // Then
    expect(archiveTransport('smoldot-direct', blockSource)).toEqual({ blockSource });
    expect(archiveTransport('smoldot-shared-worker', blockSource)).toEqual({ blockSource });
  });

  it('As a dotli developer on rpc-gateway, the Archive tab reads from the IPFS gateway, as the sandbox reads it', () => {
    // Then
    expect(archiveTransport('rpc-gateway', () => Promise.resolve(new Uint8Array()))).toEqual({ gateway: true });
  });

  it("As the debug panel, the room I report docks beside the sandbox checker's at the bottom edge, not over it", () => {
    // Given a frame on the page and the checker docked below it
    const apply = vi.fn<ApplyFrameBox>();
    attachProductFrame(fakeIframe(), apply);
    setDockInset({ right: 0, bottom: 100 }, 'sandbox-checker');

    // When
    debugPanelHost.reportDockInset({ right: 0, bottom: 360 });

    // Then
    expect(apply.mock.lastCall?.[1].bottom).toBe(460);
  });
});
