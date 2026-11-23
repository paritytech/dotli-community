// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createReporter, defineCount } from '@dotli/metrics';

const report = createReporter({ flow: 'chat' });

/**
 * Count. A custom message's image that draws as unavailable. Tagged `outcome` (error) and `reason` (an
 * `ImageUnavailableReason`, else the error's name).
 */
const chatImageMetric = defineCount<'error'>('chat.image');

/**
 * Why an image cannot be drawn:
 * - `not_connected`: the product has no live connection to read it through
 * - `too_large`: more bytes than its source may carry
 * - `unsupported_type`: bytes of no type its source may carry
 * - `undecodable`: bytes the browser cannot decode
 * - `missing`: the backend or the archive has no bytes for it
 * - `mismatch`: bytes that do not hash to their CID
 * - `fetch`: the backend or the archive read failed
 * - `no_archive`: the product publishes no archive to read it from
 * - `unsupported_cid`: a CID that is not one raw block
 */
export type ImageUnavailableReason =
  | 'not_connected'
  | 'too_large'
  | 'unsupported_type'
  | 'undecodable'
  | 'missing'
  | 'mismatch'
  | 'fetch'
  | 'no_archive'
  | 'unsupported_cid';

/** Where an image failed: reading its bytes, or decoding them on the page. */
type ImageStep = 'chat_image_load' | 'chat_image_decode';

/** An image a custom message names that cannot be drawn, for `reason`. */
export class ImageUnavailableError extends Error {
  override name = 'ImageUnavailableError';
  readonly reason: ImageUnavailableReason;

  constructor(reason: ImageUnavailableReason, message: string, options?: ErrorOptions) {
    super(message, options);
    this.reason = reason;
  }
}

/** Counts an image that draws as unavailable. Bytes that do not match their CID are a defect, the rest expected. */
export function reportUnavailableImage(error: unknown, step: ImageStep): void {
  if (!(error instanceof ImageUnavailableError)) {
    report.expected(error, { step, metric: chatImageMetric });
    return;
  }
  if (error.reason === 'mismatch') {
    report.defect(error, {
      step,
      metric: chatImageMetric,
      reason: error.reason,
      message: '[dot.li chat] An image does not match its CID:',
    });
    return;
  }
  report.expected(error, { step, metric: chatImageMetric, reason: error.reason });
}
