// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Where the global setup writes the scripts a test loads into a page: the protocol frame's wire and the sign-in
// window's handshake, from dot.li's own page and from a site, and a site's sign-in by redirect. Apart from the setup,
// so a test worker that needs only a path never loads vite.

import { resolve } from 'node:path';

const WIRE_DIR = resolve(import.meta.dirname, '../wire');

/** The global setup's output folder, git-ignored. */
export const WIRE_OUT_DIR = resolve(import.meta.dirname, '../.wire');

/** Records the protocol frame's messages in the host page's top window. */
export const RECORDER_BUNDLE_PATH = resolve(WIRE_OUT_DIR, 'protocol-recorder.js');

/** Runs the fake protocol frame, with the options its script tag carries. */
export const FAKE_PROTOCOL_BUNDLE_PATH = resolve(WIRE_OUT_DIR, 'fake-protocol-frame.js');

/** Opens the sign-in window from the opener fixture page and marks the round's outcome there. */
export const SESSION_OPENER_BUNDLE_PATH = resolve(WIRE_OUT_DIR, 'session-opener.js');

/** Opens the sign-in window as a third-party site and marks the window's last reply there. */
export const SITE_OPENER_BUNDLE_PATH = resolve(WIRE_OUT_DIR, 'site-opener.js');

/** Signs in as a third-party site by redirect and marks the window's sealed answer there. */
export const SITE_REDIRECT_BUNDLE_PATH = resolve(WIRE_OUT_DIR, 'site-redirect.js');

/** Each script and the module it is built from. */
export const WIRE_BUNDLES: readonly { entry: string; path: string }[] = [
  { entry: resolve(WIRE_DIR, 'protocol-recorder.ts'), path: RECORDER_BUNDLE_PATH },
  { entry: resolve(WIRE_DIR, 'fake-protocol-frame.ts'), path: FAKE_PROTOCOL_BUNDLE_PATH },
  { entry: resolve(WIRE_DIR, 'session-opener.ts'), path: SESSION_OPENER_BUNDLE_PATH },
  { entry: resolve(WIRE_DIR, 'site-opener.ts'), path: SITE_OPENER_BUNDLE_PATH },
  { entry: resolve(WIRE_DIR, 'site-redirect.ts'), path: SITE_REDIRECT_BUNDLE_PATH },
];
