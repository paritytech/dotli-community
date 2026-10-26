// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Show, type Accessor } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { ShieldState } from '../../state/url-pill.js';
import { VerificationShield } from './VerificationShield.js';

export type UrlPillShieldProps = {
  /** Undefined for any pill but a product's, null until the host knows how the product loaded. */
  shield: Accessor<ShieldState | null | undefined>;
};

/** The verification shield while the URL pill is a `.dot` product's. The rest of the pill is page markup. */
export function UrlPillShield(props: UrlPillShieldProps): JSX.Element {
  return (
    <Show when={props.shield() !== undefined}>
      <VerificationShield state={() => props.shield() ?? null} />
    </Show>
  );
}
