// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import { urlPillStore } from '../../state/url-pill.js';
import { useStore } from '../use-store.js';
import { GLYPH_PATHS, TOOLTIP_TITLE } from './verification-glyphs.js';

/**
 * The verification explainer's body (VerificationShield), its own chunk: how
 * each way of loading a site reads, the pill's current one marked
 * (`.is-current`). The icons and rows are written out rather than split into
 * components, so the markup matches the pre-Solid explainer node for node.
 */
export function VerificationContent(): JSX.Element {
  const state = useStore(urlPillStore, s => (s.kind === 'product' ? (s.shield ?? null) : null));
  return (
    <>
      <div class="verification-tooltip-title">{TOOLTIP_TITLE}</div>
      <div class={['verification-tooltip-row', { 'is-current': state() === 'verified' }]} data-state="verified">
        <svg
          class="verification-tooltip-icon is-verified"
          viewBox="0 0 24 24"
          fill="currentColor"
          fill-rule="evenodd"
          aria-hidden="true"
          // @ts-expect-error -- not in Solid's SVG types; kept from the pre-Solid markup
          focusable="false"
        >
          <path d={GLYPH_PATHS.verified} />
        </svg>
        <span class="verification-tooltip-text">
          <span class="verification-tooltip-name">
            <strong class="verification-tooltip-label">Verified</strong>
            <span class="verification-tooltip-current">This site</span>
          </span>
          <span class="verification-tooltip-desc">More secure, checked by your light client.</span>
        </span>
      </div>
      <div class={['verification-tooltip-row', { 'is-current': state() === 'trusted' }]} data-state="trusted">
        <svg
          class="verification-tooltip-icon is-trusted"
          viewBox="0 0 24 24"
          fill="currentColor"
          fill-rule="evenodd"
          aria-hidden="true"
          // @ts-expect-error -- not in Solid's SVG types; kept from the pre-Solid markup
          focusable="false"
        >
          <path d={GLYPH_PATHS.trusted} />
        </svg>
        <span class="verification-tooltip-text">
          <span class="verification-tooltip-name">
            <strong class="verification-tooltip-label">Trusted</strong>
            <span class="verification-tooltip-current">This site</span>
          </span>
          <span class="verification-tooltip-desc">Served by an external RPC provider.</span>
        </span>
      </div>
    </>
  );
}
