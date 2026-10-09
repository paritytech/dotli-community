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

const Explainer = lazy(() => import('./VerificationContent.js'), { export: 'VerificationContent' });

/**
 * The URL pill's shield and its explainer tooltip, which stays an anchored tooltip on a phone.
 * Until the host knows how the product was loaded, the verified glyph shows and the explainer is empty.
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
