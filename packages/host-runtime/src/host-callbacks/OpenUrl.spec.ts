// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi, type Mock } from 'vitest';
import { withActiveTld } from '@dotli/config';
import { createNavigateTo as createPageNavigateTo } from './OpenUrl.js';

const PORT = '3000';

let assign: Mock<(url: string) => void>;
let open: Mock<(url: string) => void>;

/** Navigation on a dev tab at localhost:3000 that records where it is sent. */
function createNavigateTo(): ReturnType<typeof createPageNavigateTo> {
  assign = vi.fn<(url: string) => void>();
  open = vi.fn<(url: string) => void>();
  return createPageNavigateTo({ location: () => ({ protocol: 'http:', port: PORT, assign }), open });
}

function spyOnNavigation(): { assign: Mock<(url: string) => void>; open: Mock<(url: string) => void> } {
  return { assign, open };
}

describe('OpenUrl host callback', () => {
  it('As a product user, a handoff to another dotNS product moves the current tab', async () => {
    // Given
    const navigateTo = createNavigateTo();
    const { assign, open } = spyOnNavigation();

    // When
    await navigateTo(`https://${withActiveTld('dim2')}`);

    // Then
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith(`http://dim2.localhost:${PORT}`);
    expect(open).not.toHaveBeenCalled();
  });

  it('As a product user, the path, query and hash of the target product survive the handoff', async () => {
    // Given
    const navigateTo = createNavigateTo();
    const { assign } = spyOnNavigation();

    // When
    await navigateTo(`polkadot://${withActiveTld('dim2')}/play?round=3#top`);

    // Then
    expect(assign).toHaveBeenCalledWith(`http://dim2.localhost:${PORT}/play?round=3#top`);
  });

  it('As a product developer, a handoff to a localhost product moves the current tab into the host proxy path', async () => {
    // Given
    const navigateTo = createNavigateTo();
    const { assign, open } = spyOnNavigation();

    // When
    await navigateTo('localhost:5199/path?q=1');

    // Then
    expect(assign).toHaveBeenCalledWith(`http://localhost:${PORT}/localhost:5199/path?q=1`);
    expect(open).not.toHaveBeenCalled();
  });

  it('As a dotli integrator, the host opens external websites apart from the current tab', async () => {
    // Given
    const navigateTo = createNavigateTo();
    const { assign, open } = spyOnNavigation();

    // When
    await navigateTo('https://example.com/path');
    await navigateTo('example.dot/path');

    // Then
    expect(assign).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenCalledWith('https://example.com/path');
    expect(open).toHaveBeenCalledWith('example.dot/path');
  });
});
