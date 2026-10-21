// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Show, type Accessor } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { TrustedShieldIcon } from '../icons/TrustedShieldIcon.js';
import { VerifiedShieldIcon } from '../icons/VerifiedShieldIcon.js';
import type { ShieldState } from '../../state/url-pill.js';
import s from './VerificationContent.module.css';

const SOURCES: readonly { state: ShieldState; title: string; description: string }[] = [
  {
    state: 'verified',
    title: 'Verified',
    description: 'Checked in your browser by the light client. The more secure option.',
  },
  {
    state: 'trusted',
    title: 'Trusted',
    description: 'Served by an external RPC provider. Faster, but you rely on its answers.',
  },
];

/** The explainer's body: how this product was loaded, or nothing while the host does not know yet. */
export function VerificationContent(props: { state: Accessor<ShieldState | null> }): JSX.Element {
  const selected = (): (typeof SOURCES)[number] | undefined => SOURCES.find(source => source.state === props.state());

  return (
    <Show when={selected()}>
      {source => (
        <div class={s['source']} data-testid={`verification-tooltip-row-${source().state}`}>
          {source().state === 'trusted' ? (
            <TrustedShieldIcon
              class={[s['icon'], s['trusted']]}
              testId="verification-tooltip-icon"
              strokeWidth="1.75"
            />
          ) : (
            <VerifiedShieldIcon
              class={[s['icon'], s['verified']]}
              testId="verification-tooltip-icon"
              strokeWidth="1.75"
            />
          )}
          <div class={s['text']}>
            <p class={s['title']}>{source().title}</p>
            <p class={s['description']}>{source().description}</p>
          </div>
        </div>
      )}
    </Show>
  );
}
