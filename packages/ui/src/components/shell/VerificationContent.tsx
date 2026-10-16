// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { ShieldState } from '../../verification-shield.js';
import { pillShield, urlPillStore } from '../../state/url-pill.js';
import { useStore } from '../use-store.js';
import { TrustedShieldIcon, VerifiedShieldIcon } from './ShieldIcons.js';
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

export function VerificationContent(): JSX.Element {
  const state = useStore(urlPillStore, pill => pillShield(pill) ?? null);
  const selected = (): (typeof SOURCES)[number] | undefined => SOURCES.find(source => source.state === state());

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
