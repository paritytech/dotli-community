// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { resetAllStoresForTests } from '@dotli/shared/testing';
import type { ProductAuthor, ProductAuthorResult } from '../createProductAuthor.js';
import { parsePolkadotAccount } from '../runtime/polkadotAccount.js';
import { recordNotified } from '../testing/recordNotified.js';
import { productCardState } from './productCardState.js';

const ADDRESS = parsePolkadotAccount('5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY');

const AUTHOR: ProductAuthor = {
  address: ADDRESS,
  username: { name: 'alice', kind: 'full' },
};

const RENAMED_AUTHOR: ProductAuthor = {
  address: ADDRESS,
  username: { name: 'alice.dot', kind: 'full' },
};

afterEach(() => {
  resetAllStoresForTests();
});

/** Returns a source that settles each load with the next of `answers`, in order. */
function createSource(...answers: Promise<ProductAuthorResult>[]): () => Promise<ProductAuthorResult> {
  const pending = [...answers];
  function load(): Promise<ProductAuthorResult> {
    const answer = pending.shift();
    if (answer === undefined) {
      throw new Error(`The author source was loaded more than the ${String(answers.length)} times it answers`);
    }
    return answer;
  }
  return load;
}

describe('product card store', () => {
  it('As a page with no author source yet, I ask for the author and nothing changes', async () => {
    // Given no source handed over
    const notified = recordNotified(productCardState.store);

    // When the card asks for the author
    await productCardState.loadAuthor();

    // Then the author stays idle
    expect(notified).toEqual([]);
    expect(productCardState.store.get().author).toEqual({ status: 'idle' });
  });

  it('As a visitor, I open the card and the author goes from loading to ready', async () => {
    // Given a source held until it answers
    const answer = Promise.withResolvers<ProductAuthorResult>();
    productCardState.setAuthorSource(createSource(answer.promise));
    const notified = recordNotified(productCardState.store);

    // When the card asks and the source answers
    const loaded = productCardState.loadAuthor();
    answer.resolve({ kind: 'found', author: AUTHOR });
    await loaded;

    // Then the card shows loading first and then the author
    expect(notified.map(state => state.author)).toEqual([{ status: 'loading' }, { status: 'ready', author: AUTHOR }]);
  });

  it('As a visitor, I open the card of a product with no owner and see no author', async () => {
    // Given a source that answers none at once
    productCardState.setAuthorSource(createSource(Promise.resolve({ kind: 'none' })));

    // When the card asks
    await productCardState.loadAuthor();

    // Then the card is ready with no author
    expect(productCardState.store.get().author).toEqual({ status: 'ready', author: null });
  });

  it('As a visitor, I open the card again after it showed the author and it keeps showing it while it updates', async () => {
    // Given a first load that showed the author, and a second answer held until it settles
    const update = Promise.withResolvers<ProductAuthorResult>();
    productCardState.setAuthorSource(createSource(Promise.resolve({ kind: 'found', author: AUTHOR }), update.promise));
    await productCardState.loadAuthor();
    const notified = recordNotified(productCardState.store);

    // When the card asks again and the new answer lands
    const loaded = productCardState.loadAuthor();
    update.resolve({ kind: 'found', author: RENAMED_AUTHOR });
    await loaded;

    // Then the old author shows until the new one replaces it, with no loading between
    expect(notified.map(state => state.author)).toEqual([{ status: 'ready', author: RENAMED_AUTHOR }]);
  });

  it('As a visitor, I open the card again after it settled and the card does not change', async () => {
    // Given a first load that showed the author, and a source that answers the same result again
    const settled: ProductAuthorResult = { kind: 'found', author: AUTHOR };
    productCardState.setAuthorSource(createSource(Promise.resolve(settled), Promise.resolve(settled)));
    await productCardState.loadAuthor();
    const notified = recordNotified(productCardState.store);

    // When the card asks again
    await productCardState.loadAuthor();

    // Then the store does not notify
    expect(notified).toEqual([]);
  });

  it("As a page, I show the product's icon in the card", () => {
    // Given a card with no icon yet

    // When the page sets the icon
    productCardState.setIcon('blob:x');

    // Then the card shows it and the author stays idle
    expect(productCardState.store.get()).toEqual({ icon: 'blob:x', author: { status: 'idle' } });
  });
});
