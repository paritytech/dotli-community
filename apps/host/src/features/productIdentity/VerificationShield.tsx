// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Show, type Accessor } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { PendingShieldIcon } from './PendingShieldIcon.js';
import { TrustedShieldIcon } from './TrustedShieldIcon.js';
import { VerifiedShieldIcon } from './VerifiedShieldIcon.js';
import type { ShieldState } from './urlPillState.js';
import { CONNECTION_LABELS } from './connectionLabels.js';
import s from './VerificationShield.module.css';

export type VerificationShieldProps = {
  /** Null until the host knows how the product loaded. */
  state: Accessor<ShieldState | null>;
  /** The product's icon, which takes the shield's place once known. Null or absent shows the shield. */
  icon?: Accessor<string | null> | undefined;
};

/**
 * The URL pill's shield, a glyph named by how the product was loaded. Once the product's icon is known it shows in
 * the glyph's place, with the state's shield on its corner once the host knows how it loaded.
 * Until the host knows (`state` null), a bare shield shows and assistive tech skips it.
 */
export function VerificationShield(props: VerificationShieldProps): JSX.Element {
  const label = (): string | undefined => {
    const state = props.state();
    return state === null ? undefined : CONNECTION_LABELS[state];
  };
  const icon = (): string | null => props.icon?.() ?? null;

  return (
    <span
      class={s['shield']}
      data-testid="verification-shield"
      data-state={props.state() ?? undefined}
      data-icon={icon() === null ? undefined : ''}
      role={label() === undefined ? undefined : 'img'}
      aria-label={label()}
      aria-hidden={label() === undefined ? 'true' : undefined}
    >
      <Show
        when={icon()}
        fallback={
          <>
            <PendingShieldIcon class={[s['glyph'], s['pendingGlyph']]} testId="verification-shield-icon" />
            <VerifiedShieldIcon class={[s['glyph'], s['verifiedGlyph']]} testId="verification-shield-icon" />
            <TrustedShieldIcon class={[s['glyph'], s['trustedGlyph']]} testId="verification-shield-icon" />
          </>
        }
      >
        {src => (
          <>
            <img class={s['productIcon']} src={src()} alt="" width="20" height="20" data-testid="url-pill-icon" />
            <VerifiedShieldIcon
              class={[s['badge'], s['verifiedBadge']]}
              strokeWidth="2.5"
              testId="url-pill-verified-badge"
            />
            <TrustedShieldIcon
              class={[s['badge'], s['trustedBadge']]}
              strokeWidth="2.5"
              testId="url-pill-trusted-badge"
            />
          </>
        )}
      </Show>
    </span>
  );
}
