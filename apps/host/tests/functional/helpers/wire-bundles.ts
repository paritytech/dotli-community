// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Where the global setup writes the scripts that speak the real protocol wire in a page. Apart from the setup, so a
// test worker that needs only a path never loads vite.

import { resolve } from 'node:path';

const WIRE_DIR = resolve(import.meta.dirname, '../wire');

/** The global setup's output folder, git-ignored. */
export const WIRE_OUT_DIR = resolve(import.meta.dirname, '../.wire');

/** Records the protocol frame's messages in the host page's top window. */
export const RECORDER_BUNDLE_PATH = resolve(WIRE_OUT_DIR, 'protocol-recorder.js');

/** Runs the fake protocol frame, with the options its script tag carries. */
export const FAKE_PROTOCOL_BUNDLE_PATH = resolve(WIRE_OUT_DIR, 'fake-protocol-frame.js');

/** Each script and the module it is built from. */
export const WIRE_BUNDLES: readonly { entry: string; path: string }[] = [
  { entry: resolve(WIRE_DIR, 'protocol-recorder.ts'), path: RECORDER_BUNDLE_PATH },
  { entry: resolve(WIRE_DIR, 'fake-protocol-frame.ts'), path: FAKE_PROTOCOL_BUNDLE_PATH },
];
