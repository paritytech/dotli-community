// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, type Page } from '@playwright/test';

export async function extractQrPayload(page: Page, canvasSelector: string, timeoutMs = 30_000): Promise<string> {
  const canvas = page.locator(canvasSelector);
  await expect(canvas).toHaveAttribute('data-qr-payload', /^polkadotapp:\/\//, { timeout: timeoutMs });
  const payload = await canvas.getAttribute('data-qr-payload');
  if (payload === null) {
    throw new Error('the QR canvas lost its payload');
  }
  return payload;
}
