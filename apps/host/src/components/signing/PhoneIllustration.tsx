// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createUniqueId } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { LogoSymbol } from '@dotli/ui/brand';
import s from './PhoneIllustration.module.css';

const SYMBOL_HEIGHT = 46;

/** A phone showing Polkadot App with its Reject and Sign buttons, the Sign button pressed on a slow loop. */
export function PhoneIllustration(): JSX.Element {
  // Gradients are referenced by id across the whole document, so each phone names its own.
  const id = createUniqueId();
  const body = `phone-body-${id}`;
  const fade = `phone-fade-${id}`;
  return (
    <div class={s['phone']} aria-hidden="true">
      <svg class={s['art']} width="234" height="309" viewBox="0 0 234 309" fill="none">
        <defs>
          <linearGradient id={body} x1="117" y1="0" x2="117" y2="309" gradientUnits="userSpaceOnUse">
            <stop offset="0" class={s['bodyTop']} />
            <stop offset="1" class={s['bodyBottom']} />
          </linearGradient>
          <linearGradient id={fade} x1="117" y1="188" x2="117" y2="309" gradientUnits="userSpaceOnUse">
            <stop offset="0" class={s['fadeTop']} />
            <stop offset="1" class={s['fadeBottom']} />
          </linearGradient>
        </defs>
        <path
          class={s['outline']}
          fill={`url(#${body})`}
          d="M40 0.75H194C215.677 0.75 233.25 18.3228 233.25 40V308.25H0.75V40C0.75 18.3228 18.3228 0.75 40 0.75Z"
        />
        <rect class={s['reject']} x="11" y="246" width="100" height="30" rx="8" />
        <text class={s['rejectText']} x="61" y="265">
          Reject
        </text>
        <g class={s['tap']}>
          <rect class={s['sign']} x="120" y="246" width="100" height="30" rx="8" />
          <text class={s['signText']} x="170" y="265">
            Sign
          </text>
        </g>
        <rect class={s['fade']} fill={`url(#${fade})`} y="188" width="234" height="121" />
      </svg>
      <div class={s['symbol']}>
        <LogoSymbol height={SYMBOL_HEIGHT} />
      </div>
      <div class={s['label']}>Polkadot App</div>
    </div>
  );
}
