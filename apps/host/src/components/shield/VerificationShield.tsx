// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, type Accessor } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { Tooltip } from '@dotli/ui';
import { TrustedShieldIcon } from '../icons/TrustedShieldIcon.js';
import { VerifiedShieldIcon } from '../icons/VerifiedShieldIcon.js';
import type { ShieldState } from '../../state/url-pill.js';
import { VERIFICATION_SHIELD_ID, VERIFICATION_TOOLTIP_ID } from './verification-shield.js';
import { VerificationContent } from './VerificationContent.js';
import s from './VerificationShield.module.css';

/**
 * The URL pill's shield and its explainer tooltip, which stays an anchored tooltip on a phone.
 * Until the host knows how the product was loaded (`state` null), the verified glyph shows and the explainer is empty.
 */
export function VerificationShield(props: { state: Accessor<ShieldState | null> }): JSX.Element {
  const [button, setButton] = createSignal<HTMLButtonElement | undefined>(undefined, { ownedWrite: true });

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
        <VerificationContent state={props.state} />
      </Tooltip>
    </div>
  );
}
