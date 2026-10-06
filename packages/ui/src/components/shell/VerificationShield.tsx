// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { For, lazy, onSettled } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { VERIFICATION_SHIELD_ID, VERIFICATION_TOOLTIP_ID, type ShieldState } from '../../verification-shield.js';
import { pillShield, urlPillStore } from '../../state/url-pill.js';
import { Tooltip } from '../floating/Tooltip.js';
import { preloadWhenIdle } from '../idle.js';
import { useStore } from '../use-store.js';
import { GLYPH_PATHS, TOOLTIP_TITLE } from './verification-glyphs.js';
import s from './VerificationShield.module.css';

/** The explainer's body, its own chunk. */
const Explainer = lazy(() => import('./VerificationContent.js'), { export: 'VerificationContent' });

// The explainer's copy per state is in the JSX below; the button names the
// state too, so it is not conveyed by colour alone.
const BUTTON_LABEL: Record<ShieldState, string> = {
  verified: 'Verified via light client',
  trusted: 'Loaded from a trusted provider',
};

/**
 * The URL pill's shield (`#verification-shield`) and its "How was this site
 * loaded?" explainer (`#verification-tooltip`), a Tooltip that drops from the
 * bar below the shield: it shows while a mouse rests on the shield, at once
 * when the shield gets keyboard focus, and on a tap; Enter or Space on the
 * shield toggles it. It hides once the pointer has left the shield and the
 * explainer, and on the shield's blur, Escape, a press or focus elsewhere
 * and the window's blur (a tap inside the product iframe). It takes no
 * focus, and is the same anchored tooltip on a phone, no sheet. The shield's
 * state is the url-pill store's (pillShield), null until the host knows how
 * the product was loaded: the button carries it as `data-state`, the
 * verified glyph shows (CSS) and no row is marked as this site.
 * The explainer's body, VerificationContent, is its own chunk, preloaded
 * when the browser is idle.
 *
 * Rendered by the URL pill's UrlPillShield island.
 */
export function VerificationShield(): JSX.Element {
  const state = useStore(urlPillStore, pill => pillShield(pill) ?? null);
  const label = (): string => {
    const current = state();
    return current === null ? TOOLTIP_TITLE : `${BUTTON_LABEL[current]}. ${TOOLTIP_TITLE}`;
  };
  onSettled(() => preloadWhenIdle(Explainer));

  return (
    <div class={s['wrap']}>
      <Tooltip id={VERIFICATION_TOOLTIP_ID}>
        <Tooltip.Trigger>
          {t => (
            <button
              {...t}
              type="button"
              id={VERIFICATION_SHIELD_ID}
              class={s['shield']}
              data-state={state() ?? undefined}
              aria-label={label()}
            >
              <svg
                class={[s['glyph'], s['verifiedGlyph']]}
                data-testid="verification-shield-icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
                // @ts-expect-error -- not in Solid's SVG types; kept from the pre-Solid markup
                focusable="false"
              >
                <For each={GLYPH_PATHS.verified}>{d => <path d={d} />}</For>
              </svg>
              <svg
                class={[s['glyph'], s['trustedGlyph']]}
                data-testid="verification-shield-icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
                // @ts-expect-error -- not in Solid's SVG types; kept from the pre-Solid markup
                focusable="false"
              >
                <For each={GLYPH_PATHS.trusted}>{d => <path d={d} />}</For>
              </svg>
            </button>
          )}
        </Tooltip.Trigger>
        <Tooltip.Content class={s['tooltip']}>
          <Explainer />
        </Tooltip.Content>
      </Tooltip>
    </div>
  );
}
