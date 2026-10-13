// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { ShowNotification } from '@dotli/ui-widgets';
import { memoryStorage } from '@dotli/shared/testing';
import { offerDesktopApp } from './desktop-offer.js';

type Offer = Parameters<ShowNotification>[0];

/** The page's storage where the browser blocks it: every access throws. */
function blockedStorage(): never {
  throw new DOMException('The operation is insecure.', 'SecurityError');
}

describe('desktop offer', () => {
  it('As a desktop visitor whose browser blocks storage, I still get the offer, and dismissing it throws nothing', () => {
    // Given
    const shown: Offer[] = [];

    // When
    offerDesktopApp({ storage: blockedStorage, notify: offer => shown.push(offer) });
    shown[0]?.onDismiss?.();

    // Then
    expect(shown.map(offer => offer.label)).toEqual(['Get Polkadot Desktop']);
  });

  it('As a desktop visitor, I dismiss the offer once and am not offered it again', () => {
    // Given
    const storage = memoryStorage();
    const first: Offer[] = [];
    offerDesktopApp({ storage: () => storage, notify: offer => first.push(offer) });

    // When
    first[0]?.onDismiss?.();
    const again: Offer[] = [];
    offerDesktopApp({ storage: () => storage, notify: offer => again.push(offer) });

    // Then
    expect(first).toHaveLength(1);
    expect(again).toEqual([]);
  });

  it('As a desktop visitor, the offer links to the download page the build names, else the public one', () => {
    // Given
    const shown: Offer[] = [];

    // When
    offerDesktopApp({
      storage: () => memoryStorage(),
      notify: offer => shown.push(offer),
      downloadUrl: 'https://example.com/desktop',
    });
    offerDesktopApp({ storage: () => memoryStorage(), notify: offer => shown.push(offer) });

    // Then
    expect(shown.map(offer => offer.deeplink)).toEqual([
      'https://example.com/desktop',
      'https://polkadot.com/get-started/polkadot-for-desktop',
    ]);
  });
});
