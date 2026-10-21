// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The product page script of the ViolationPanel stories. It posts each violation from the product's own window, as
// the sandbox's guarded APIs do, so the panel sees the product frame as the source.

(window as Window & { violate?: (api: string, details?: Record<string, unknown>) => void }).violate = (
  api,
  details,
) => {
  parent.postMessage({ type: 'DOTLI_API_VIOLATION', api, details, timestamp: 0 }, '*');
};
