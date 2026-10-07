// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, lazy, onSettled } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { VERIFICATION_SHIELD_ID, VERIFICATION_TOOLTIP_ID } from '../../verification-shield.js';
import { pillShield, urlPillStore } from '../../state/url-pill.js';
import { Tooltip } from '../floating/Tooltip.js';
import { preloadWhenIdle } from '../idle.js';
import { useStore } from '../use-store.js';
import { TrustedShieldIcon, VerifiedShieldIcon } from './ShieldIcons.js';
import s from './VerificationShield.module.css';

/** The explainer's body, its own chunk. */
const Explainer = lazy(() => import('./VerificationContent.js'), { export: 'VerificationContent' });

/**
 * The URL pill's shield (`#verification-shield`) and its explainer of how
 * this site was loaded (`#verification-tooltip`), a Tooltip that drops from the
 * bar below the shield: it shows while a mouse rests on the shield, at once
 * when the shield gets keyboard focus, and on a tap; Enter or Space on the
 * shield toggles it. It hides once the pointer has left the shield and the
 * explainer, and on the shield's blur, Escape, a press or focus elsewhere
 * and the window's blur (a tap inside the product iframe). It takes no
 * focus, and is the same anchored tooltip on a phone, no sheet. The shield's
 * state is the url-pill store's (pillShield), null until the host knows how
 * the product was loaded: the button carries it as `data-state`, the
 * verified glyph shows (CSS) and the explainer is empty.
 * The explainer's body, VerificationContent, is its own chunk, preloaded
 * when the browser is idle.
 *
 * Rendered by the URL pill's UrlPillShield island.
 */
export function VerificationShield(): JSX.Element {
  const state = useStore(urlPillStore, pill => pillShield(pill) ?? null);
  const [button, setButton] = createSignal<HTMLButtonElement | undefined>(undefined, { ownedWrite: true });
  onSettled(() => preloadWhenIdle(Explainer));

  return (
    <div class={s['wrap']}>
      <button
        ref={setButton}
        type="button"
        id={VERIFICATION_SHIELD_ID}
        class={s['shield']}
        aria-label="Site verification"
        data-state={state() ?? undefined}
      >
        <VerifiedShieldIcon class={[s['glyph'], s['verifiedGlyph']]} testId="verification-shield-icon" />
        <TrustedShieldIcon class={[s['glyph'], s['trustedGlyph']]} testId="verification-shield-icon" />
      </button>
      <Tooltip id={VERIFICATION_TOOLTIP_ID} trigger={button()} class={s['tooltip']}>
        <Explainer />
      </Tooltip>
    </div>
  );
}
