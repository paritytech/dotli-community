// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { markHandled } from '@dotli/shared';
import { loadQrCode } from '../../lazy.js';
import { wholeModuleSide } from './qrSize.js';

export type QrDrawOptions = {
  /**
   * The side the layout allows in px, quiet zone included. The code is drawn at the largest whole-pixel module size
   * within it.
   */
  width: number;
  /** The quiet zone, in modules. */
  margin: number;
  errorCorrectionLevel: 'L' | 'M' | 'Q' | 'H';
  color: { dark: string; light: string };
};

type QrDrawParams = {
  canvas: HTMLCanvasElement;
  payload: string;
  options: QrDrawOptions;
  signal: AbortSignal;
};

/** Draws `payload` as a QR code onto `canvas`. Once `signal` aborts the code is off show, so drawing it is wasted. */
export type DrawQr = (params: QrDrawParams) => Promise<void>;

/** Draws `payload` as a QR code with the lazily loaded `qrcode` chunk. */
export const drawQrCode: DrawQr = async ({ canvas, payload, options, signal }) => {
  const QRCode = await loadQrCode();
  if (signal.aborted) {
    return;
  }
  const { modules } = QRCode.default.create(payload, { errorCorrectionLevel: options.errorCorrectionLevel });
  const width = wholeModuleSide(options.width, modules.size, options.margin);
  await QRCode.default.toCanvas(canvas, payload, { ...options, width });
  // The canvas shows at the size it was drawn, which the stylesheet may scale down to fit a narrow screen.
  canvas.style.removeProperty('width');
  canvas.style.removeProperty('height');
};

/**
 * Starts the `qrcode` chunk while the pairing deeplink is made, so the code draws as soon as it comes. A failed load is
 * not reported here, since the drawing imports again and reports its own failure.
 */
export function prepareQrCode(load: () => Promise<unknown> = loadQrCode): void {
  void markHandled(load());
}
