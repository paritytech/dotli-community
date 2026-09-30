// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import { VERIFICATION_SHIELD_ID, VERIFICATION_TOOLTIP_ID, type ShieldState } from '../../verification-shield.js';
import { createPopover } from './popover.js';

const TOOLTIP_TITLE = 'How was this site loaded?';

const SHIELD_OUTLINE = 'M12 2L3 7v5c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V7l-9-5z';

// Material "gpp_good" / "gpp_maybe" vocabulary: a check for verified, an
// exclamation mark for "protected, but take note". Both cut out of one fill.
const GLYPH_PATHS: Record<ShieldState, string> = {
  verified: `${SHIELD_OUTLINE}m-1 14.59l-3.29-3.3 1.41-1.41L11 13.76l4.88-4.88 1.41 1.41L11 16.59z`,
  trusted: `${SHIELD_OUTLINE}M11 7.5h2v6h-2zM11 15.5h2v2h-2z`,
};

// The explainer's copy per state is in the JSX below; the button names the
// state too, so it is not conveyed by colour alone.
const BUTTON_LABEL: Record<ShieldState, string> = {
  verified: 'Verified via light client',
  trusted: 'Loaded from a trusted provider',
};

/**
 * The URL pill's shield (`#verification-shield`) and its "How was this site
 * loaded?" explainer (`#verification-tooltip`), a disclosure: the button
 * toggles the explainer (createPopover's `popover` mode), which closes on a
 * press outside both, on focus leaving both, on Escape (focus back to the
 * button when it was inside or lost to the body), on window blur (a tap
 * inside the product iframe) and when a blocking modal comes up. `state`
 * is null until the host knows how the product was loaded: the verified
 * glyph shows (CSS) and no row is marked as this site.
 *
 * Rendered by the URL pill's UrlPillShield island, so its listeners
 * are native, added in callback refs. The icons and rows are written out
 * rather than split into components: a component among siblings leaves a
 * marker comment in the DOM, and the markup matches the pre-Solid shield
 * node for node.
 */
export function VerificationShield(props: { state: ShieldState | null }): JSX.Element {
  let button: HTMLButtonElement | undefined;
  let tooltip: HTMLDivElement | undefined;
  const disclosure = createPopover({
    mode: 'popover',
    trigger: () => button,
    surface: () => tooltip,
    closeOnBlur: true,
    // Nothing inside takes focus, so Tab moves on (and closes it).
    trapFocus: false,
  });
  const label = (): string => (props.state === null ? TOOLTIP_TITLE : `${BUTTON_LABEL[props.state]}. ${TOOLTIP_TITLE}`);

  return (
    <div class="verification-shield-wrap">
      <button
        ref={el => {
          button = el;
          el.addEventListener('click', disclosure.toggle);
        }}
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
        aria-expanded={disclosure.open() ? 'true' : 'false'}
        aria-controls={VERIFICATION_TOOLTIP_ID}
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
      <div
        ref={el => {
          tooltip = el;
        }}
        class={['verification-tooltip', { open: disclosure.open() }]}
        id={VERIFICATION_TOOLTIP_ID}
      >
        <div class="verification-tooltip-title">{TOOLTIP_TITLE}</div>
        <div class={['verification-tooltip-row', { 'is-current': props.state === 'verified' }]} data-state="verified">
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
        <div class={['verification-tooltip-row', { 'is-current': props.state === 'trusted' }]} data-state="trusted">
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
      </div>
    </div>
  );
}
