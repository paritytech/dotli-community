// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The sign-in QR's drawing, apart from the modal so its races are tested without a page.

import { captureException, m, spans as S } from '@dotli/metrics';
import { log } from '@dotli/shared';
import type { QrDrawOptions } from './qr-code.js';

export interface QrShowing<Canvas> {
  /** Draws `payload` onto `canvas`. Once `signal` aborts the code is off show. */
  drawQr: (canvas: Canvas, payload: string, options: QrDrawOptions, signal: AbortSignal) => Promise<void>;
  /** The canvas this showing draws on, made once. */
  createCanvas: (payload: string) => Canvas;
  /** The side to draw at, read on each drawing. */
  size: () => number;
  /** Calls `redraw` whenever the size may have changed, until the returned stop. */
  watchSize: (redraw: () => void) => () => void;
  /** A drawing finished while its code was still on show. */
  onDrawn: (drawn: { payload: string; canvas: Canvas }) => void;
}

/**
 * Shows `payload` as a QR code, drawn now and again at each size change, until the returned stop takes it off show.
 * A late answer, success or failure, says nothing about the code on show, so after the stop it is neither drawn in
 * nor reported.
 */
export function presentQr<Canvas>(payload: string, deps: QrShowing<Canvas>): () => void {
  const shown = new AbortController();
  const canvas = deps.createCanvas(payload);
  // A size notice can come after the first drawing already read the new size, as when the viewport settles while the
  // code opens, so a size is drawn once unless its drawing failed.
  let drawnWidth: number | undefined;
  const draw = (): void => {
    const width = deps.size();
    if (width === drawnWidth) {
      return;
    }
    drawnWidth = width;
    deps
      .drawQr(
        canvas,
        payload,
        {
          width,
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
          if (drawnWidth === width) {
            drawnWidth = undefined;
          }
          log.error('[dot.li] QR render failed:', err);
          captureException(err, { flow: 'wallet', step: 'qr_render' });
          // Not `errorName`: importing it here splits its module into a chunk of its own on the boot path.
          m.count(S.AUTH_QR_RENDER, { outcome: 'error', reason: err instanceof Error ? err.name : 'unknown' });
        },
      );
  };
  draw();
  const unwatch = deps.watchSize(draw);
  return () => {
    shown.abort();
    unwatch();
  };
}
