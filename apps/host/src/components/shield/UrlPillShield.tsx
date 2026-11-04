// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, createSignal, onSettled, Show, type Accessor } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { preloadWhenIdle, Tooltip } from '@dotli/ui';
import type { ProductCardView } from '../../state/productCardView.js';
import type { ShieldState } from '../../state/urlPillState.js';
import { OpenProductCard, preloadProductCard } from '../productCard/OpenProductCard.js';
import { VerificationShield } from './VerificationShield.js';
import s from './UrlPillShield.module.css';

export type UrlPillShieldProps = {
  /** Undefined for any pill but a product's, null until the host knows how the product loaded. */
  shield: Accessor<ShieldState | null | undefined>;
  /** Null while there is no product card to show. */
  card: Accessor<ProductCardView | null>;
  /** Called once per opening of the product card. */
  onCardShow: () => void;
};

/**
 * The verification shield while the URL pill is a `.dot` product's, and the product card the pill opens once the
 * product rendered. The rest of the pill is page markup, so the card's trigger is found from where this mounts.
 */
export function UrlPillShield(props: UrlPillShieldProps): JSX.Element {
  let anchor: HTMLSpanElement | undefined;
  const [pill, setPill] = createSignal<HTMLElement | undefined>(undefined, { ownedWrite: true });
  // A ref runs before its element is in the page, where there is no pill to find yet.
  onSettled(() => {
    setPill(anchor?.closest<HTMLElement>('#url-pill') ?? undefined);
  });
  // The card's chunk loads while idle once there is a card, so the first opening skips the network.
  createEffect(
    () => props.card() !== null,
    hasCard => (hasCard ? preloadWhenIdle({ preload: preloadProductCard }) : undefined),
  );
  return (
    <span
      class={s['anchor']}
      ref={el => {
        anchor = el;
      }}
    >
      <Show when={props.shield() !== undefined}>
        <VerificationShield state={() => props.shield() ?? null} icon={() => props.card()?.icon ?? null} />
      </Show>
      <Show when={props.card()}>
        {card => (
          <Tooltip id="product-card-tooltip" width="md" class={s['card']} trigger={pill()}>
            <OpenProductCard card={card()} onShow={props.onCardShow} />
          </Tooltip>
        )}
      </Show>
    </span>
  );
}
