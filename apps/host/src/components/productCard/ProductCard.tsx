// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { LogoSymbol } from '@dotli/ui/brand';
import { AccountAvatar } from '../account/AccountAvatar.js';
import type { AccountSession } from '../account/account.js';
import { shortenAccount } from '../account/accountNames.js';
import { TrustedShieldIcon } from '../icons/TrustedShieldIcon.js';
import { VerifiedShieldIcon } from '../icons/VerifiedShieldIcon.js';
import { CONNECTION_LABELS } from '../shield/connectionLabels.js';
import type { AuthorUsername, ProductAuthor } from '../../createProductAuthor.js';
import type { AuthorStatus } from '../../state/productCardState.js';
import type { ProductCardView } from '../../state/productCardView.js';
import type { ShieldState } from '../../state/urlPillState.js';
import s from './ProductCard.module.css';

export type ProductCardProps = { card: ProductCardView };

/** The product card's body: the product, its author and how it loaded. Reads no store, the caller passes the view. */
export function ProductCard(props: ProductCardProps): JSX.Element {
  return (
    <div class={s['card']} data-testid="product-card">
      <div class={s['icon']}>
        <Show when={props.card.icon} fallback={<LogoSymbol class={s['mark']} height={24} testId="product-card-mark" />}>
          {icon => (
            <img class={s['image']} src={icon()} alt="" width="40" height="40" data-testid="product-card-icon" />
          )}
        </Show>
      </div>
      <div class={s['body']}>
        <div class={s['heading']}>
          <p class={s['name']} data-testid="product-card-name">
            {props.card.name}
          </p>
          <p class={s['domain']} data-testid="product-card-domain">
            {props.card.domain}
          </p>
        </div>
        <Show when={props.card.description}>
          {description => (
            <p class={s['description']} data-testid="product-card-description">
              {description()}
            </p>
          )}
        </Show>
        {getAuthorSection(props.card.author)}
        <Show when={props.card.connection}>{state => <ConnectionRow state={state()} />}</Show>
      </div>
    </div>
  );
}

function getAuthorSection(author: AuthorStatus): JSX.Element {
  switch (author.status) {
    // The section appears once an author is found. Loading and no owner show nothing.
    case 'idle':
    case 'loading':
      return null;
    case 'ready':
      return author.author === null ? null : (
        <AuthorSection>
          <AuthorRow author={author.author} />
        </AuthorSection>
      );
  }
}

function AuthorSection(props: { children: JSX.Element }): JSX.Element {
  return (
    <div class={s['author']} data-testid="product-card-author">
      <p class={s['label']}>Author</p>
      {props.children}
    </div>
  );
}

function AuthorRow(props: { author: ProductAuthor }): JSX.Element {
  return (
    <div class={s['row']}>
      <AccountAvatar session={getAvatarSession(props.author.username)} size="sm" decorative />
      <div class={s['who']}>
        <Show when={props.author.username}>
          {username => (
            <span class={s['username']} data-testid="product-card-author-name">
              {username().name}
            </span>
          )}
        </Show>
        <span class={s['address']} data-testid="product-card-author-address">
          {shortenAccount(props.author.address) ?? props.author.address}
        </span>
      </div>
    </div>
  );
}

function getAvatarSession(username: AuthorUsername | null): AccountSession {
  if (username === null) {
    return {};
  }
  switch (username.kind) {
    case 'full':
      return { fullUsername: username.name };
    case 'lite':
      return { liteUsername: username.name };
  }
}

function ConnectionRow(props: { state: ShieldState }): JSX.Element {
  return (
    <>
      <hr class={s['divider']} />
      <div class={s['connection']} data-testid="product-card-connection" data-state={props.state}>
        {getShieldGlyph(props.state)}
        <span class={s['connectionLabel']}>{CONNECTION_LABELS[props.state]}</span>
      </div>
    </>
  );
}

function getShieldGlyph(state: ShieldState): JSX.Element {
  switch (state) {
    case 'verified':
      return <VerifiedShieldIcon class={s['glyph']} strokeWidth="1.75" />;
    case 'trusted':
      return <TrustedShieldIcon class={s['glyph']} strokeWidth="1.75" />;
  }
}
