// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The sign-in QR's drawing, apart from the modal so its races are tested without a page.

import { createReporter, defineCount } from '@dotli/metrics';
import type { QrDrawOptions } from './qrCode.js';

const report = createReporter({ flow: 'wallet' });

/**
 * One drawing of the sign-in QR code. Tagged `outcome` and, on error, `reason`, as a failed one leaves the sign-in on
 * its spinner with nothing to scan.
 */
const authQrRenderMetric = defineCount<'error' | 'ok'>('auth.qr_render');

export type QrShowing<Canvas> = {
  /** Draws `payload` onto `canvas`. Once `signal` aborts the code is off show. */
  drawQr: (canvas: Canvas, payload: string, options: QrDrawOptions, signal: AbortSignal) => Promise<void>;
  /** The canvas this showing draws on, made once. */
  createCanvas: (payload: string) => Canvas;
  /** The side to draw at. */
  size: () => number;
  /** A drawing finished while its code was still on show. */
  onDrawn: (drawn: { payload: string; canvas: Canvas }) => void;
};

/**
 * Shows `payload` as a QR code, drawn once, until the returned stop takes it off show. A late answer, success or
 * failure, says nothing about the code on show, so after the stop it is neither drawn in nor reported.
 */
export function presentQr<Canvas>(payload: string, deps: QrShowing<Canvas>): () => void {
  const shown = new AbortController();
  const canvas = deps.createCanvas(payload);
  deps
    .drawQr(
      canvas,
      payload,
      {
        width: deps.size(),
        margin: 2,
        // The badge hides the code's centre: Q recovers a quarter of it.
        errorCorrectionLevel: 'Q',
        color: { dark: '#000000', light: '#ffffff' },
      },
      shown.signal,
    )
    .then(
      () => {
        if (shown.signal.aborted) {
          return;
        }
        authQrRenderMetric.count({ outcome: 'ok' });
        deps.onDrawn({ payload, canvas });
      },
      (err: unknown) => {
        if (shown.signal.aborted) {
          return;
        }
        report.defect(err, {
          step: 'qr_render',
          metric: authQrRenderMetric,
          message: '[dot.li] QR render failed:',
        });
      },
    );
  return () => {
    shown.abort();
  };
}
