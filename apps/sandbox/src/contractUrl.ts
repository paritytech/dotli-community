// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { SANDBOX_CONTRACT_PARAMS } from '@dotli/sandbox-wire';

/** `href` without the params the host hands the sandbox, so the product sees only the user's own. */
export function withoutContractParams(href: string): string {
  const cleaned = new URL(href);
  for (const key of Object.values(SANDBOX_CONTRACT_PARAMS)) {
    cleaned.searchParams.delete(key);
  }
  return cleaned.toString();
}
