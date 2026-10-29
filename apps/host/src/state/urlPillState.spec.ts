// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { resetAllStoresForTests } from '@dotli/shared/testing';
import { recordNotified } from '../testing/recordNotified.js';
import { urlPillState, type ShieldState, type UrlPillState } from './urlPillState.js';

afterEach(() => {
  resetAllStoresForTests();
});

describe('url pill store', () => {
  it.each<{ situation: string; state: UrlPillState; shield: ShieldState | null | undefined }>([
    { situation: 'with no product on show', state: { kind: 'none' }, shield: undefined },
    { situation: 'on a local product', state: { kind: 'localhost', host: 'localhost:3000' }, shield: undefined },
    {
      situation: 'on a product still loading',
      state: { kind: 'product', domain: 'app', tld: '.dot', shield: null },
      shield: null,
    },
    {
      situation: 'on a trusted product',
      state: { kind: 'product', domain: 'app', tld: '.dot', shield: 'trusted' },
      shield: 'trusted',
    },
  ])('As a user $situation, I look at the URL pill and see the shield $shield', ({ state, shield }) => {
    // When
    const shown = urlPillState.getPillShield(state);

    // Then
    expect(shown).toBe(shield);
  });

  it('As a user, I open a local product, then a .dot product and its shield, and the URL pill shows each in turn', () => {
    // Given
    const notified = recordNotified(urlPillState.store);

    // When
    urlPillState.showLocalhost('localhost:3000');
    urlPillState.showProduct('app', '.dot.li');
    urlPillState.setVerificationShield('trusted');

    // Then
    expect(notified).toEqual([
      { kind: 'localhost', host: 'localhost:3000' },
      { kind: 'product', domain: 'app', tld: '.dot.li', shield: null },
      { kind: 'product', domain: 'app', tld: '.dot.li', shield: 'trusted' },
    ]);
  });

  it('As a user, I get the same shield and the same local pill again and the URL pill redraws once', () => {
    // Given
    urlPillState.showProduct('app', '.dot');
    urlPillState.setVerificationShield('verified');
    const notified = recordNotified(urlPillState.store);

    // When
    urlPillState.setVerificationShield('verified');
    urlPillState.showLocalhost('localhost:3000');
    urlPillState.showLocalhost('localhost:3000');

    // Then
    expect(notified).toEqual([{ kind: 'localhost', host: 'localhost:3000' }]);
  });

  it('As a user on a local product, I get a verification shield and the URL pill does not change', () => {
    // Given
    urlPillState.showLocalhost('localhost:3000');
    const notified = recordNotified(urlPillState.store);

    // When
    urlPillState.setVerificationShield('verified');

    // Then
    expect(notified).toEqual([]);
  });
});
