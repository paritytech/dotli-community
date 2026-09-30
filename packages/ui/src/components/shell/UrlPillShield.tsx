// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { pillShield, urlPillStore } from '../../state/url-pill.js';
import { useStore } from '../use-store.js';
import { VerificationShield } from './VerificationShield.js';

/**
 * The URL pill's verification shield, an island (see src/islands/) in the
 * pill the host page renders (apps/host/src/components/UrlPill.astro): the
 * shield and its explainer while the pill is a `.dot` product's, in the
 * state the url-pill store holds for it; nothing otherwise. The rest of the
 * pill is the page's markup, which bindUrlPill (url-pill.ts) fills in.
 */
export function UrlPillShield(): JSX.Element {
  const shown = useStore(urlPillStore, state => pillShield(state) !== undefined);
  return (
    <Show when={shown()}>
      <VerificationShield />
    </Show>
  );
}
