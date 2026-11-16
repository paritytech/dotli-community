// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Which files are test code. Globs match from each package's own config.

// Unit specs, the fake of one module beside it, and shared fixtures.
export const testOnlyFiles = [
  '**/src/**/*.spec.ts',
  '**/src/**/*.spec.tsx',
  '**/src/**/*.fake.ts',
  '**/src/testing/**/*.ts',
  '**/src/testing/**/*.tsx',
];

// An app's functional and end-to-end tests beside its source, in a feature or the shell, which run in happy-dom or
// Playwright.
export const featureTestFiles = ['**/src/**/__tests__/**/*.ts', '**/src/**/__tests__/**/*.tsx'];

export const storyFiles = ['**/src/**/*.stories.tsx'];
