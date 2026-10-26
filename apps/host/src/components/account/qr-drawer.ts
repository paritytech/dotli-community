// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The sign-in QR's drawing, apart from the modal so its races are tested without a page.

import { captureException, m, spans as S } from '@dotli/metrics';
import { errorName, log } from '@dotli/shared';
import type { QrDrawOptions } from './qr-code.js';

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
        m.count(S.AUTH_QR_RENDER, { outcome: 'ok' });
        deps.onDrawn({ payload, canvas });
      },
      (err: unknown) => {
        if (shown.signal.aborted) {
          return;
        }
        log.error('[dot.li] QR render failed:', err);
        captureException(err, { flow: 'wallet', step: 'qr_render' });
        m.count(S.AUTH_QR_RENDER, { outcome: 'error', reason: errorName(err) ?? 'unknown' });
      },
    );
  return () => {
    shown.abort();
  };
}
