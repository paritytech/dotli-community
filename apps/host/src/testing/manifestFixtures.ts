// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The manifest records a product publishes, as text and as this host reads them.

import { toExecutableManifestResult, toRootManifestResult } from '@dotli/resolver';

/** A root manifest's text. */
export const ROOT_TEXT = JSON.stringify({
  $v: 1,
  displayName: 'DOOM',
  description: 'Doom',
  icon: { cid: 'bafk', format: 'png' },
});
/** A valid root manifest. */
export const ROOT = toRootManifestResult(ROOT_TEXT);
/** A valid app manifest. */
export const APP = toExecutableManifestResult(JSON.stringify({ $v: 1, kind: 'app', appVersion: [0, 1, 9] }), 'app');
/** A record nothing was published to. */
export const EMPTY = { kind: 'empty' } as const;
/** A record on a network whose resolver has no text records. */
export const NO_TEXT_RECORDS = { kind: 'unsupported', reason: 'TEXT_RECORDS slot not configured' } as const;
/** What `app.doom.paseo` publishes, an app manifest in a version this host does not read. */
export const APP_V2_TEXT = JSON.stringify({
  $v: 2,
  kind: 'app',
  appVersion: [0, 1, 9],
  runtime: { kind: 'polkavm' },
});
/** `APP_V2_TEXT` as this host reads it. */
export const APP_V2 = toExecutableManifestResult(APP_V2_TEXT, 'app');
