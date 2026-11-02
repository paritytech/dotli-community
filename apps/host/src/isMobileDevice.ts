// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { isRecord } from '@dotli/shared';

/** Returns whether the browser runs on a phone or tablet, by its client hints, else its user agent. Never throws. */
export function isMobileDevice(): boolean {
  const hinted = readClientHintMobile();
  if (hinted !== undefined) {
    return hinted;
  }
  const userAgent = navigator.userAgent;
  // iPadOS 13+ reports a desktop Safari UA, so touch points disambiguate.
  if (userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1) {
    return true;
  }
  return /Mobi|Android|iPhone|iPad|iPod/i.test(userAgent);
}

/** Returns the client hints' mobile flag, or undefined in a browser that sends no client hints. */
function readClientHintMobile(): boolean | undefined {
  if (!('userAgentData' in navigator) || !isRecord(navigator.userAgentData)) {
    return undefined;
  }
  const { mobile } = navigator.userAgentData;
  return typeof mobile === 'boolean' ? mobile : undefined;
}
