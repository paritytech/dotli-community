// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { isSharedAuthOriginAllowed } from './isSharedAuthOriginAllowed.js';

describe('isSharedAuthOriginAllowed', () => {
  it('As the shared auth store, I serve host shell origins and refuse product origins', () => {
    // Given three host shell origins, two product origins and a stranger
    const shells = ['https://dot.li', 'https://browse.dot.li', 'https://host-playground.dot.li'];
    const others = ['https://bafy.app.dot.li', 'https://app.dot.li', 'https://evil.example.com'];

    // When each asks for the shared auth store
    const shellsAllowed = shells.map(origin => isSharedAuthOriginAllowed(origin));
    const othersAllowed = others.map(origin => isSharedAuthOriginAllowed(origin));

    // Then only the host shells are served
    expect(shellsAllowed).toEqual([true, true, true]);
    expect(othersAllowed).toEqual([false, false, false]);
  });

  it('As a page on host.<domain>, I open the frame and am admitted as a parent alongside product hosts', () => {
    // Given host.<domain> deployed and on localhost
    const origins = ['https://host.dot.li', 'http://host.localhost:5173'];

    // When each asks for the shared auth store
    const allowed = origins.map(origin => isSharedAuthOriginAllowed(origin));

    // Then both are admitted
    expect(allowed).toEqual([true, true]);
  });

  it('As the shared auth store in development, I serve localhost host shells and refuse localhost product origins', () => {
    // Given two localhost host shells and a localhost product origin
    const shells = ['http://localhost:5173', 'http://browse.localhost:5173'];
    const product = 'http://bafy.app.localhost:5173';

    // When each asks for the shared auth store
    const shellsAllowed = shells.map(origin => isSharedAuthOriginAllowed(origin));
    const productAllowed = isSharedAuthOriginAllowed(product);

    // Then only the host shells are served
    expect(shellsAllowed).toEqual([true, true]);
    expect(productAllowed).toBe(false);
  });

  it('As a developer on local.host, I reach the shared auth store from a host shell and am served while a product origin is refused', () => {
    // Given two host shells, two product origins and a lookalike, all in development on local.host
    const shells = ['https://local.host:4321', 'https://browse.local.host:4321'];
    const others = ['https://bafy.app.local.host:4322', 'https://app.local.host:4321', 'http://notlocal.host'];

    // When each asks for the shared auth store
    const shellsAllowed = shells.map(origin => isSharedAuthOriginAllowed(origin, { dev: true }));
    const othersAllowed = others.map(origin => isSharedAuthOriginAllowed(origin, { dev: true }));

    // Then only the host shells are served
    expect(shellsAllowed).toEqual([true, true]);
    expect(othersAllowed).toEqual([false, false, false]);
  });

  it('As a user of a production build, I reach the shared auth store and every local.host origin is refused while localhost is served', () => {
    // Given local.host and localhost origins in a production build
    const localHost = ['https://local.host:4321', 'https://browse.local.host:4321', 'http://browse.local.host:5173'];
    const localhost = ['http://localhost:5173', 'http://browse.localhost:5173'];

    // When each asks for the shared auth store
    const localHostAllowed = localHost.map(origin => isSharedAuthOriginAllowed(origin, { dev: false }));
    const localhostAllowed = localhost.map(origin => isSharedAuthOriginAllowed(origin, { dev: false }));

    // Then every local.host origin is refused and localhost is served
    expect(localHostAllowed).toEqual([false, false, false]);
    expect(localhostAllowed).toEqual([true, true]);
  });
});
