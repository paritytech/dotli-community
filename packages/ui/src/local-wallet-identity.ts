// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { LocalWalletBoot } from './wallet-boot.js';

/** Undefined when there is nothing to re-activate, otherwise the new name, null when the account has none. */
export function refreshLiteUsername(_wallet: LocalWalletBoot): Promise<string | null | undefined> {
  return Promise.resolve(undefined);
}
