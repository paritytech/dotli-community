// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { enhanceCodec, str } from 'scale-ts';

/** What went wrong in a VM that runs in a Web Worker, as the page sees it: its message, with every cause in it. */
export class QuickJsVmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuickJsVmError';
  }
}

/** Carries a `QuickJsVmError` as its message, and decodes it back into one. */
export const quickJsVmErrorCodec = enhanceCodec(
  str,
  (error: QuickJsVmError) => error.message,
  message => new QuickJsVmError(message),
);
