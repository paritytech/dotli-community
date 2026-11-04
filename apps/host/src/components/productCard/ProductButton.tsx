// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The product button and the sheet it opens: the product card, then a link home.

import { createMemo, createSignal, Show, type Accessor } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { ButtonLink, IconButton, Popover } from '@dotli/ui';
import { LogoSymbol, LogoWordmark } from '@dotli/ui/brand';
import type { ProductCardView } from '../../state/productCardView.js';
import { OpenProductCard, preloadProductCard } from './OpenProductCard.js';
import s from './ProductButton.module.css';

export type ProductButtonProps = {
  /** Null while there is no product card to show. */
  card: Accessor<ProductCardView | null>;
  /** Called once per opening of the product card. */
  onCardShow: () => void;
  /** Where the sheet's link home goes. */
  homeUrl: string;
};

/**
 * The product's icon, or the Polkadot mark until it has one, opening the product card and a link home as a sheet.
 * Rendered with no card too, so the button is in the page before any product loads.
 */
export function ProductButton(props: ProductButtonProps): JSX.Element {
  const [button, setButton] = createSignal<HTMLButtonElement | undefined>(undefined, { ownedWrite: true });
  // Read once in an owned scope, as the accessor may subscribe to a store on each read.
  const card = createMemo(() => props.card());
  const title = (): string => {
    const current = card();
    return current === null ? 'dot.li' : `About ${current.domain}`;
  };
  return (
    <span class={s['slot']} data-product-button="">
      <IconButton
        ref={el => {
          setButton(el);
        }}
        id="product-button"
        aria-label={title()}
      >
        <Show when={card()?.icon} fallback={<LogoSymbol height={24} testId="product-button-mark" />}>
          {icon => (
            <img class={s['icon']} src={icon()} alt="" width="28" height="28" data-testid="product-button-icon" />
          )}
        </Show>
      </IconButton>
      {/* The popover reads `preload` once, so it warms the chunk only when the card exists by then. */}
      <Popover
        id="product-sheet"
        title={title()}
        trigger={button()}
        preload={card() === null ? undefined : preloadProductCard}
      >
        <Show when={card()}>{current => <OpenProductCard card={current()} onShow={props.onCardShow} />}</Show>
        <div class={s['footer']}>
          <ButtonLink href={props.homeUrl} block testId="product-sheet-home">
            Open
            <LogoSymbol height={20} />
            <LogoWordmark height={13} />
          </ButtonLink>
        </div>
      </Popover>
    </span>
  );
}
