// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The islands that call `loadAuthor` hydrate apart from the page that builds the author read, so the read is handed
// over here, not passed in.

import { isShallowEqual, registerAtomReset, registerStoreStateReset } from '@dotli/shared';
import { atom, type ReadableAtom } from 'nanostores';
import type { ProductAuthor, ProductAuthorResult } from '../createProductAuthor.js';

/** `ready` with a null author means the product has no owner. */
export type AuthorStatus =
  { status: 'idle' } | { status: 'loading' } | { status: 'ready'; author: ProductAuthor | null };

/** `icon` is null until the product's icon is known. */
export type ProductCardState = { icon: string | null; author: AuthorStatus };

type AuthorSource = () => Promise<ProductAuthorResult>;

const card = atom<ProductCardState>({ icon: null, author: { status: 'idle' } });
card.eq = isShallowEqual;
registerAtomReset(card);
const store: ReadableAtom<ProductCardState> = card;

let authorSource: AuthorSource | undefined;

/** What the product card shows: the product's icon and its author. */
export const productCardState = {
  /** The card's content. Notifies only when a field changes. */
  store,
  /** Shows `href` as the product's icon. Never throws. */
  setIcon,
  /**
   * Hands over the product's author read, which must never reject. Replaces any read handed over before. Never throws.
   */
  setAuthorSource,
  /** Loads the product's author into the card. Does nothing until the page hands over its source. Never rejects. */
  loadAuthor,
};

// The store resets itself. The source beside it is let go.
registerStoreStateReset(() => {
  authorSource = undefined;
});

function setIcon(href: string): void {
  card.set({ ...card.get(), icon: href });
}

function setAuthorSource(load: AuthorSource): void {
  authorSource = load;
}

async function loadAuthor(): Promise<void> {
  if (authorSource === undefined) {
    return;
  }
  const { status } = card.get().author;
  // A shown author stays up while it updates.
  if (status === 'idle') {
    setAuthor({ status: 'loading' });
  }
  setAuthor(getAuthorStatus(await authorSource()));
}

function getAuthorStatus(result: ProductAuthorResult): AuthorStatus {
  switch (result.kind) {
    case 'found':
      return { status: 'ready', author: result.author };
    case 'none':
      return { status: 'ready', author: null };
  }
}

function setAuthor(author: AuthorStatus): void {
  const current = card.get();
  // Each load builds a new status, so an answer the card already shows is not written again.
  if (isShallowEqual(current.author, author)) {
    return;
  }
  card.set({ ...current, author });
}
