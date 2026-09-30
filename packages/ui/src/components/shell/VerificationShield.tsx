// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { lazy } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { VERIFICATION_SHIELD_ID, VERIFICATION_TOOLTIP_ID, type ShieldState } from '../../verification-shield.js';
import { Popover } from './Popover.js';
import { GLYPH_PATHS, TOOLTIP_TITLE } from './verification-glyphs.js';

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
 * loaded?" explainer (`#verification-tooltip`), a Popover under the shield,
 * in the body: a disclosure (the button toggles it, and it takes no focus)
 * that also shows while a mouse rests on the shield, and a bottom sheet on
 * phones. It closes on a press outside both, on focus leaving both, on
 * Escape (focus back to the button when it was inside or lost to the body),
 * on window blur (a tap inside the product iframe) and when a blocking modal
 * comes up. `state` is null until the host knows how the product was
 * loaded: the verified glyph shows (CSS) and no row is marked as this site.
 * The explainer's body, VerificationContent, is its own chunk.
 *
 * Rendered by the URL pill's UrlPillShield island.
 */
export function VerificationShield(props: { state: ShieldState | null }): JSX.Element {
  const label = (): string => (props.state === null ? TOOLTIP_TITLE : `${BUTTON_LABEL[props.state]}. ${TOOLTIP_TITLE}`);

  return (
    <div class="verification-shield-wrap">
      <Popover
        id={VERIFICATION_TOOLTIP_ID}
        title={TOOLTIP_TITLE}
        class="verification-tooltip"
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
            class={[
              'verification-shield',
              {
                verified: props.state === 'verified',
                trusted: props.state === 'trusted',
              },
            ]}
            aria-label={label()}
          >
            <svg
              class="verification-shield-icon is-verified"
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
              class="verification-shield-icon is-trusted"
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
