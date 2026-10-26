// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { shallowEqual } from '@dotli/shared';
import type { AuthModalView } from '../../../state/auth-modal.js';

function pairs(view: AuthModalView): boolean {
  return view.kind === 'spinner' || view.kind === 'pairing';
}

/**
 * Whether two views show on one screen, so a layout keeps the screen it built. The code being made and the code to
 * scan share the pairing screen, which reads the payload as it comes, so a choice made on it before the code arrives
 * lasts.
 */
export function sameSignInScreen(a: AuthModalView, b: AuthModalView): boolean {
  return pairs(a) && pairs(b) ? true : shallowEqual(a, b);
}

/** The pairing deeplink a view carries, null while it is being made. */
export function pairingPayload(view: AuthModalView): string | null {
  return view.kind === 'pairing' ? view.payload : null;
}
