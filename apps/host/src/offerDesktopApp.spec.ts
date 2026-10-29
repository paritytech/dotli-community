// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { ShowNotification } from '@dotli/ui';
import { createMemoryStorage } from '@dotli/shared/testing';
import { offerDesktopApp } from './offerDesktopApp.js';
import { createBlockedStorage } from './testing/createBlockedStorage.js';

type Offer = Parameters<ShowNotification>[0];

describe('desktop offer', () => {
  it('As a desktop visitor whose browser blocks storage, I still get the offer, and dismissing it throws nothing', () => {
    // Given
    const shown: Offer[] = [];

    // When
    offerDesktopApp({ storage: createBlockedStorage(), notify: offer => shown.push(offer) });
    shown[0]?.onDismiss?.();

    // Then
    expect(shown.map(offer => offer.label)).toEqual(['Get Polkadot Desktop']);
  });

  it('As a desktop visitor, I dismiss the offer once and am not offered it again', () => {
    // Given
    const storage = createMemoryStorage();
    const first: Offer[] = [];
    offerDesktopApp({ storage, notify: offer => first.push(offer) });

    // When
    first[0]?.onDismiss?.();
    const again: Offer[] = [];
    offerDesktopApp({ storage, notify: offer => again.push(offer) });

    // Then
    expect(first).toHaveLength(1);
    expect(again).toEqual([]);
  });

  it('As a desktop visitor, I get the offer and it links to the download page the build names, else the public one', () => {
    // Given
    const shown: Offer[] = [];

    // When
    offerDesktopApp({
      storage: createMemoryStorage(),
      notify: offer => shown.push(offer),
      downloadUrl: 'https://example.com/desktop',
    });
    offerDesktopApp({ storage: createMemoryStorage(), notify: offer => shown.push(offer) });

    // Then
    expect(shown.map(offer => offer.deeplink)).toEqual([
      'https://example.com/desktop',
      'https://polkadot.com/get-started/polkadot-for-desktop',
    ]);
  });
});
