// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createReporter, defineCount } from '@dotli/metrics';
import { ImageUnavailableError } from './imageUnavailableError.js';

/** Where an image failed: reading its bytes, or decoding them on the page. */
type ImageStep = 'chat_image_load' | 'chat_image_decode';

const report = createReporter({ flow: 'chat' });

/**
 * Count. A custom message's image that draws as unavailable. Tagged `outcome` (error) and `reason` (an
 * `ImageUnavailableReason`, else the error's name).
 */
const chatImageMetric = defineCount<'error'>('chat.image');

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
