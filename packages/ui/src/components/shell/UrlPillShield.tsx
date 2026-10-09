// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { pillShield, urlPillStore } from '../../state/url-pill.js';
import { useStore } from '../use-store.js';
import { VerificationShield } from './VerificationShield.js';

/**
 * Island that shows the verification shield while the URL pill is a `.dot` product's.
 * The rest of the pill is page markup that bindUrlPill (url-pill.ts) fills in.
 */
export function UrlPillShield(): JSX.Element {
  const shown = useStore(urlPillStore, state => pillShield(state) !== undefined);
  return (
    <Show when={shown()}>
      <VerificationShield />
    </Show>
  );
}
