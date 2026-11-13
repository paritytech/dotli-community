// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the sandbox page's URL says about the host's contract.

import { getLocalRoot } from '@dotli/config';
import { SandboxContractError, validateSandboxParams } from '@dotli/sandbox-wire';
import type { SandboxParams } from './loadProduct.js';

export type SandboxPage = {
  /** The page's URL, which carries the host's contract. */
  href: string;
  /** Whether the page runs in a frame, as the host renders it. */
  framed: boolean;
};

/** What the page's URL says about the host's contract. */
export type SandboxContract =
  | { kind: 'topLevel'; host: string }
  | { kind: 'offOrigin' }
  | { kind: 'unreadable'; error: SandboxContractError }
  | { kind: 'readable'; params: SandboxParams };

/**
 * Reads the host's contract from `href`. Throws when `href` is no URL, or when the check fails with anything but a
 * contract error.
 */
export function readSandboxContract({ href, framed }: SandboxPage, baseDomain: string): SandboxContract {
  const url = new URL(href);
  if (!framed) {
    return { kind: 'topLevel', host: url.host };
  }
  // A bare `app.<root>` fails loudly. Only a `<label>.app.<root>` origin is confirmed, since the CID arrives on the host
  // contract.
  if (!url.hostname.endsWith(`.app.${getLocalRoot(url.hostname) ?? baseDomain}`)) {
    return { kind: 'offOrigin' };
  }
  // The sandbox cannot read the host's localStorage, so every setting arrives in the URL. A missing or invalid value
  // is a hard error, never a silent default. Extra keys are the user's own and pass through.
  try {
    return { kind: 'readable', params: validateSandboxParams(url.searchParams) };
  } catch (error) {
    if (!(error instanceof SandboxContractError)) {
      throw error;
    }
    return { kind: 'unreadable', error };
  }
}
