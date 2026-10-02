// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { pillShield, urlPillStore } from '../../state/url-pill.js';
import { useStore } from '../use-store.js';
import { usePopover } from './Popover.js';
import { GLYPH_PATHS, TOOLTIP_TITLE } from './verification-glyphs.js';
import s from './VerificationContent.module.css';

/**
 * The verification explainer's body (VerificationShield), its own chunk: how
 * each way of loading a site reads, the pill's current one marked
 * (`data-current`). Its heading is left out of a sheet, whose header names
 * it.
 */
export function VerificationContent(): JSX.Element {
  const popover = usePopover();
  const state = useStore(urlPillStore, pill => pillShield(pill) ?? null);
  return (
    <div class={s['content']}>
      <Show when={!popover.sheet()}>
        <div class={s['title']} data-testid="verification-tooltip-title">
          {TOOLTIP_TITLE}
        </div>
      </Show>
      <div
        class={s['row']}
        data-testid="verification-tooltip-row"
        data-state="verified"
        data-current={state() === 'verified' ? '' : undefined}
      >
        <svg
          class={s['icon']}
          data-testid="verification-tooltip-icon"
          viewBox="0 0 24 24"
          fill="currentColor"
          fill-rule="evenodd"
          aria-hidden="true"
          // @ts-expect-error -- not in Solid's SVG types; kept from the pre-Solid markup
          focusable="false"
        >
          <path d={GLYPH_PATHS.verified} />
        </svg>
        <span class={s['text']}>
          <span class={s['name']}>
            <strong class={s['label']}>Verified</strong>
            <span class={s['current']}>This site</span>
          </span>
          <span class={s['desc']}>More secure, checked by your light client.</span>
        </span>
      </div>
      <div
        class={s['row']}
        data-testid="verification-tooltip-row"
        data-state="trusted"
        data-current={state() === 'trusted' ? '' : undefined}
      >
        <svg
          class={s['icon']}
          data-testid="verification-tooltip-icon"
          viewBox="0 0 24 24"
          fill="currentColor"
          fill-rule="evenodd"
          aria-hidden="true"
          // @ts-expect-error -- not in Solid's SVG types; kept from the pre-Solid markup
          focusable="false"
        >
          <path d={GLYPH_PATHS.trusted} />
        </svg>
        <span class={s['text']}>
          <span class={s['name']}>
            <strong class={s['label']}>Trusted</strong>
            <span class={s['current']}>This site</span>
          </span>
          <span class={s['desc']}>Served by an external RPC provider.</span>
        </span>
      </div>
    </div>
  );
}
