// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Inline in the head of every host page, so the stored theme applies before first paint.

import { paintStoredTheme } from '../theme-paint.js';

paintStoredTheme({
  storage: () => localStorage,
  colorScheme: () => matchMedia('(prefers-color-scheme: light)'),
  root: () => document.documentElement,
});
