// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Mood, MoodIntensity, MoodKind } from '../src/profile/profile-record.js';

/** A current mood set a minute ago, with a day to run. */
export function mood(kind: MoodKind, intensity: MoodIntensity = 'steady'): Mood {
  return { kind, intensity, setAt: Math.floor(Date.now() / 1000) - 60, ttlSecs: 24 * 3600 };
}

/** A raster portrait drawn on a canvas: a hue's gradient and two initials. */
function portraitCanvas(hue: number, initials: string): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const context = canvas.getContext('2d');
  if (context === null) {
    throw new Error('No 2D canvas for the story portrait');
  }
  const gradient = context.createLinearGradient(0, 0, 256, 256);
  gradient.addColorStop(0, `hsl(${String(hue)} 70% 62%)`);
  gradient.addColorStop(1, `hsl(${String(hue + 40)} 60% 30%)`);
  context.fillStyle = gradient;
  context.fillRect(0, 0, 256, 256);
  context.fillStyle = 'rgba(255, 255, 255, 0.92)';
  context.font = '600 104px system-ui, sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(initials, 128, 136);
  return canvas;
}

/** The portrait as a PNG data URL, for a slot's `photoUrl`. */
export function portraitUrl(hue: number, initials: string): string {
  return portraitCanvas(hue, initials).toDataURL('image/png');
}

/** The portrait's PNG bytes, as a decrypted profile's avatar. */
export async function portraitBytes(hue: number, initials: string): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>(resolve => {
    portraitCanvas(hue, initials).toBlob(resolve, 'image/png');
  });
  if (blob === null) {
    throw new Error('The story portrait did not encode');
  }
  return new Uint8Array(await blob.arrayBuffer());
}
