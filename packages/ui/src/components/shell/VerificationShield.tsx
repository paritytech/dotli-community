// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { lazy } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { VERIFICATION_SHIELD_ID, VERIFICATION_TOOLTIP_ID, type ShieldState } from '../../verification-shield.js';
import { pillShield, urlPillStore } from '../../state/url-pill.js';
import { useStore } from '../use-store.js';
import { Popover } from './Popover.js';
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
 * loaded?" explainer (`#verification-tooltip`), a Popover that drops from the pill below the shield,
 * in the body: a disclosure (the button toggles it, and it takes no focus)
 * that also shows while a mouse rests on the shield, and a bottom sheet on
 * phones. It closes on a press outside both, on focus leaving both, on
 * Escape (focus back to the button when it was inside or lost to the body),
 * on window blur (a tap inside the product iframe) and when a blocking modal
 * comes up. The shield's state is the url-pill store's (pillShield), null
 * until the host knows how the product was loaded: the button carries it as
 * `data-state`, the verified glyph shows (CSS) and no row is marked as this
 * site.
 * The explainer's body, VerificationContent, is its own chunk.
 *
 * Rendered by the URL pill's UrlPillShield island.
 */
export function VerificationShield(): JSX.Element {
  const state = useStore(urlPillStore, pill => pillShield(pill) ?? null);
  const label = (): string => {
    const current = state();
    return current === null ? TOOLTIP_TITLE : `${BUTTON_LABEL[current]}. ${TOOLTIP_TITLE}`;
  };

  return (
    <div class={s['wrap']}>
      <Popover
        id={VERIFICATION_TOOLTIP_ID}
        title={TOOLTIP_TITLE}
        class={s['tooltip']}
        anchor="trigger"
        disclosure
        openOnHover
        closeOnBlur
        // Nothing inside takes focus, so Tab moves on (and closes it).
        trapFocus={false}
        content={Explainer}
        trigger={t => (
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
              fill="currentColor"
              fill-rule="evenodd"
              aria-hidden="true"
              // @ts-expect-error -- not in Solid's SVG types; kept from the pre-Solid markup
              focusable="false"
            >
              <path d={GLYPH_PATHS.verified} />
            </svg>
            <svg
              class={[s['glyph'], s['trustedGlyph']]}
              data-testid="verification-shield-icon"
              viewBox="0 0 24 24"
              fill="currentColor"
              fill-rule="evenodd"
              aria-hidden="true"
              // @ts-expect-error -- not in Solid's SVG types; kept from the pre-Solid markup
              focusable="false"
            >
              <path d={GLYPH_PATHS.trusted} />
            </svg>
          </button>
        )}
      />
    </div>
  );
}
