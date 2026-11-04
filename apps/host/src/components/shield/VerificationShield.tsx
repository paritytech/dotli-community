// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Accessor } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { TrustedShieldIcon } from '../icons/TrustedShieldIcon.js';
import { VerifiedShieldIcon } from '../icons/VerifiedShieldIcon.js';
import type { ShieldState } from '../../state/urlPillState.js';
import { CONNECTION_LABELS } from './connectionLabels.js';
import { VERIFICATION_SHIELD_ID } from './verificationShieldIds.js';
import s from './VerificationShield.module.css';

/**
 * The URL pill's shield, a glyph named by how the product was loaded.
 * Until the host knows (`state` null), the verified glyph shows and assistive tech skips it.
 */
export function VerificationShield(props: { state: Accessor<ShieldState | null> }): JSX.Element {
  const label = (): string | undefined => {
    const state = props.state();
    return state === null ? undefined : CONNECTION_LABELS[state];
  };

  return (
    <span
      id={VERIFICATION_SHIELD_ID}
      class={s['shield']}
      data-testid="verification-shield"
      data-state={props.state() ?? undefined}
      role={label() === undefined ? undefined : 'img'}
      aria-label={label()}
      aria-hidden={label() === undefined ? 'true' : undefined}
    >
      <VerifiedShieldIcon class={[s['glyph'], s['verifiedGlyph']]} testId="verification-shield-icon" />
      <TrustedShieldIcon class={[s['glyph'], s['trustedGlyph']]} testId="verification-shield-icon" />
    </span>
  );
}
