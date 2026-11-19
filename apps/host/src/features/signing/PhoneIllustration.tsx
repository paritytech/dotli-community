// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createUniqueId } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { Logo } from '@dotli/ui/brand';
import s from './PhoneIllustration.module.css';

const SYMBOL_HEIGHT = 30;

/**
 * A phone showing Polkadot App with its two answers as flat bars with no words, so neither reads as a button to press
 * here, the primary pressed on a slow loop. Its foot fades out rather than end on a flat edge.
 */
export function PhoneIllustration(): JSX.Element {
  // Gradients are referenced by id across the whole document, so each phone names its own.
  const id = createUniqueId();
  const body = `phone-body-${id}`;
  return (
    <div class={s['phone']} aria-hidden="true">
      <svg class={s['art']} width="234" height="309" viewBox="0 0 234 309" fill="none">
        <defs>
          <linearGradient id={body} x1="117" y1="0" x2="117" y2="309" gradientUnits="userSpaceOnUse">
            <stop offset="0" class={s['bodyTop']} />
            <stop offset="1" class={s['bodyBottom']} />
          </linearGradient>
        </defs>
        <path
          class={s['outline']}
          fill={`url(#${body})`}
          d="M40 0.75H194C215.677 0.75 233.25 18.3228 233.25 40V308.25H0.75V40C0.75 18.3228 18.3228 0.75 40 0.75Z"
        />
        <rect class={s['answer']} x="11" y="246" width="100" height="30" rx="8" />
        <rect class={[s['answer'], s['tap']]} x="120" y="246" width="100" height="30" rx="8" />
      </svg>
      <div class={s['symbol']}>
        <Logo variant="symbol" height={SYMBOL_HEIGHT} />
      </div>
      <div class={s['label']}>Polkadot App</div>
    </div>
  );
}
