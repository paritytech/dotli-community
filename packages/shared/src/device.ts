// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

interface UADataLike {
  mobile?: boolean;
}

// Shared phone/tablet check for the pairing deeplink, desktop-app banner, and
// topbar auto-hide. Prefers navigator.userAgentData.mobile, falls back to UA.
export function isMobileDevice(): boolean {
  const uaData = (navigator as Navigator & { userAgentData?: UADataLike })
    .userAgentData;
  if (typeof uaData?.mobile === "boolean") {
    return uaData.mobile;
  }
  const ua = navigator.userAgent;
  // iPadOS 13+ reports a desktop Safari UA, so touch points disambiguate.
  if (ua.includes("Macintosh") && navigator.maxTouchPoints > 1) {
    return true;
  }
  return /Mobi|Android|iPhone|iPad|iPod/i.test(ua);
}
