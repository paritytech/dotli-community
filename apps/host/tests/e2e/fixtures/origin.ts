// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// E2E_ORIGIN names a deployed dot.li, such as https://paseo.li, to run the suite against that deploy instead of the
// local preview server. Read on each call, since the config loads the repo-root .env after its imports run.

function deployedOrigin(): string | undefined {
  const origin = process.env['E2E_ORIGIN'];
  // The .env loader can hand us an empty string, which counts as unset.
  if (origin === undefined || origin === '') {
    return undefined;
  }
  if (new URL(origin).protocol !== 'https:') {
    throw new Error(`E2E_ORIGIN must be a deployed https origin, got ${origin}`);
  }
  return origin;
}

/** True when E2E_ORIGIN is unset, so the suite runs against a local build. Throws when E2E_ORIGIN is set to anything but an https origin. */
export function isLocalOrigin(): boolean {
  return deployedOrigin() === undefined;
}

/** The dot.li origin under test. Throws when E2E_ORIGIN is set to anything but an https origin. */
export function dotliOrigin(): string {
  return new URL(deployedOrigin() ?? `http://localhost:${process.env['PORT'] ?? '5173'}`).origin;
}

/**
 * The origin dot.li serves a product from: its label as a subdomain of the dot.li origin. Throws when E2E_ORIGIN is
 * set to anything but an https origin.
 */
export function productOrigin(label: string): string {
  const url = new URL(dotliOrigin());
  return `${url.protocol}//${label}.${url.host}`;
}
