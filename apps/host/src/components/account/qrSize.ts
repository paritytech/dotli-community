// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The side to draw a QR code at: the largest whole number of pixels per module that fits `size`, never below one.
 * A fractional module edge blurs the code, and readers (phone cameras, jsQR) fail to decode it.
 */
export function wholeModuleSide(size: number, modules: number, margin: number): number {
  const across = modules + 2 * margin;
  return Math.max(1, Math.floor(size / across)) * across;
}
