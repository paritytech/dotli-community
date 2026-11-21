// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { SectionLabel } from '@dotli/ui';
import { Logo } from '@dotli/ui/brand';
import { AccountAvatar } from '../account/index.js';
import type { AccountSession } from '../account/index.js';
import { shortenAccount } from '../account/index.js';
import { TrustedShieldIcon } from './TrustedShieldIcon.js';
import { VerifiedShieldIcon } from './VerifiedShieldIcon.js';
import { CONNECTION_LABELS } from './connectionLabels.js';
import type { AuthorName, ProductAuthor } from './createProductAuthor.js';
import type { AuthorStatus } from './productCardState.js';
import type { ProductCardView } from './productCardView.js';
import type { ShieldState } from './urlPillState.js';
import s from './ProductCard.module.css';

export type ProductCardProps = { card: ProductCardView };

/** The product card's body: the product, its author and how it loaded. Reads no store, the caller passes the view. */
export function ProductCard(props: ProductCardProps): JSX.Element {
  return (
    <div class={s['card']} data-testid="product-card">
      <div class={s['icon']}>
        <Show
          when={props.card.icon}
          fallback={<Logo variant="symbol" class={s['mark']} height={36} testId="product-card-mark" />}
        >
          {icon => (
            <img class={s['image']} src={icon()} alt="" width="40" height="40" data-testid="product-card-icon" />
          )}
        </Show>
      </div>
      <div class={s['body']}>
        <div class={s['heading']}>
          <p class={s['name']} title={props.card.name} data-testid="product-card-name">
            {props.card.name}
          </p>
          <Show when={props.card.name !== props.card.domain}>
            <p class={s['domain']} data-testid="product-card-domain">
              {props.card.domain}
            </p>
          </Show>
        </div>
        <Show when={props.card.description}>
          {description => (
            <p class={s['description']} data-testid="product-card-description" title={description()}>
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
        <div class={s['author']} data-testid="product-card-author">
          <SectionLabel class={s['label']} text="Author" />
          <AuthorRow author={author.author} />
        </div>
      );
  }
}

function AuthorRow(props: { author: ProductAuthor }): JSX.Element {
  return (
    <div class={s['row']}>
      <AccountAvatar
        session={getAvatarSession(props.author.name)}
        size="sm"
        decorative
        testId="product-card-author-avatar"
      />
      <div class={s['who']}>
        <Show when={props.author.name}>
          {name => (
            <span class={s['authorName']} data-testid="product-card-author-name">
              {name().text}
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

/** The session the avatar draws from. A dotNS name is no People username, so it keeps the user glyph. */
function getAvatarSession(name: AuthorName | null): AccountSession {
  if (name === null) {
    return {};
  }
  switch (name.kind) {
    case 'full':
      return { fullUsername: name.text };
    case 'lite':
      return { liteUsername: name.text };
    case 'dotns':
      return {};
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
