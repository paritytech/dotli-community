// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** Browser family and version for user-facing compatibility guidance only. */
function browserVersion(userAgent: string): string | null {
  const ios = /\b(?:CPU (?:iPhone )?OS|iPhone OS) (\d+(?:_\d+){0,2})\b/.exec(userAgent);
  if (ios?.[1] !== undefined) {
    return `iOS ${ios[1].replaceAll('_', '.')}`;
  }

  const edge = /\bEdg(?:A|iOS)?\/(\d+(?:\.\d+){0,3})\b/.exec(userAgent);
  if (edge?.[1] !== undefined) {
    return `Edge ${edge[1]}`;
  }

  const chrome = /\b(?:Chrome|CriOS)\/(\d+(?:\.\d+){0,3})\b/.exec(userAgent);
  if (chrome?.[1] !== undefined) {
    return `Chrome ${chrome[1]}`;
  }

  const firefox = /\b(?:Firefox|FxiOS)\/(\d+(?:\.\d+){0,3})\b/.exec(userAgent);
  if (firefox?.[1] !== undefined) {
    return `Firefox ${firefox[1]}`;
  }

  const safari = /\bVersion\/(\d+(?:\.\d+){0,3}).*\bSafari\//.exec(userAgent);
  return safari?.[1] === undefined ? null : `Safari ${safari[1]}`;
}

/** Explains a failed WebTransport capability check without using the user agent as the gate. */
export function jamPeerTransportUnavailableMessage(userAgent: string): string {
  const browser = browserVersion(userAgent);
  const subject = browser ?? 'This browser';
  return `${subject} does not provide the WebTransport support required for live JAM connections. Use Chrome or Edge 100+, Firefox 125+, or Safari/iOS 26.4+. This app will use its verified snapshot instead.`;
}
