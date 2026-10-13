// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, lazy, onSettled, untrack, type Accessor } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { preloadWhenIdle, Tooltip } from '@dotli/ui';
import { TrustedShieldIcon, VerifiedShieldIcon } from '@dotli/ui-entities';
import type { ShieldState } from '../../state/url-pill.js';
import { VERIFICATION_SHIELD_ID, VERIFICATION_TOOLTIP_ID } from './verification-shield.js';
import { loadVerificationContent } from '../../lazy.js';
import s from './VerificationShield.module.css';

const PageExplainer = lazy(loadVerificationContent, { export: 'VerificationContent' });

/** Loads the explainer's chunk. */
export type ExplainerLoader = typeof loadVerificationContent;

/**
 * The URL pill's shield and its explainer tooltip, which stays an anchored tooltip on a phone.
 * Until the host knows how the product was loaded (`state` null), the verified glyph shows and the explainer is empty.
 * `loadExplainer` defaults to the page's chunk.
 */
export function VerificationShield(props: {
  state: Accessor<ShieldState | null>;
  loadExplainer?: ExplainerLoader | undefined;
}): JSX.Element {
  const load = untrack(() => props.loadExplainer);
  const Explainer = load === undefined ? PageExplainer : lazy(load, { export: 'VerificationContent' });
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
        data-state={props.state() ?? undefined}
      >
        <VerifiedShieldIcon class={[s['glyph'], s['verifiedGlyph']]} testId="verification-shield-icon" />
        <TrustedShieldIcon class={[s['glyph'], s['trustedGlyph']]} testId="verification-shield-icon" />
      </button>
      <Tooltip id={VERIFICATION_TOOLTIP_ID} trigger={button()} class={s['tooltip']}>
        <Explainer state={props.state} />
      </Tooltip>
    </div>
  );
}
