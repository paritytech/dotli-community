// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { removeContractParams } from '@dotli/sandbox-wire';

/**
 * `href` without the params the host hands the sandbox, so the product sees only the user's own, each with its bytes as
 * typed. Throws on an `href` that is no URL.
 */
export function stripContractParams(href: string): string {
  const cleaned = new URL(href);
  const productQuery = removeContractParams(cleaned.search);
  if (productQuery === cleaned.search.slice(1)) {
    return href;
  }
  cleaned.search = productQuery;
  return cleaned.toString();
}
