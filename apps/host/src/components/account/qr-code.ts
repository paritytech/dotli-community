// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { loadQrCode } from '../../lazy.js';

export interface QrDrawOptions {
  /** The drawn side in px, quiet zone included. */
  width: number;
  /** The quiet zone, in modules. */
  margin: number;
  errorCorrectionLevel: 'L' | 'M' | 'Q' | 'H';
  color: { dark: string; light: string };
}

/** Draws `payload` as a QR code onto `canvas`. Once `signal` aborts the code is off show, so drawing it is wasted. */
export type DrawQr = (
  canvas: HTMLCanvasElement,
  payload: string,
  options: QrDrawOptions,
  signal?: AbortSignal,
) => Promise<void>;

/** Fetches the `qrcode` chunk with the first code shown, so a visit that never signs in never loads it. */
export const drawQrCode: DrawQr = async (canvas, payload, options, signal) => {
  const QRCode = await loadQrCode();
  if (signal?.aborted === true) {
    return;
  }
  await QRCode.default.toCanvas(canvas, payload, options);
};
