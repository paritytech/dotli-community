// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Inline in the head of a product sub-page the service worker serves, before any product script reads the path. The
// worker puts the prefix on the tag as `data-prefix`.

import { pathWithoutAppPrefix } from '../app-prefix.js';

const prefix = document.currentScript?.dataset['prefix'];
const path = prefix === undefined ? null : pathWithoutAppPrefix(location, prefix);
if (path !== null) {
  history.replaceState(null, '', path);
}
