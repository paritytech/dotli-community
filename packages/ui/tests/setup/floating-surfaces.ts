// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeAll } from 'vitest';

// Popover's and DropdownMenu's surfaces are lazy chunks. The tests open a
// surface and read it in the same tick, as they did while it was eager, so
// the chunks load once per file, ahead of its tests. Imported in the hook,
// not at the top: by then the file's `vi.mock`s are registered, so neither
// the shells nor what they import (@dotli/metrics) are loaded unmocked, and
// a file can hold a surface chunk back (popover-surface-loading.test.tsx).
// A file's mocks must leave the shells loadable: a mock of a module they
// import keeps its other exports (`importOriginal`).
beforeAll(async () => {
  const [popover, menu] = await Promise.all([
    import('../../src/components/floating/Popover.js'),
    import('../../src/components/floating/DropdownMenu.js'),
  ]);
  await Promise.all([popover.preloadPopoverSurface(), menu.preloadDropdownMenuSurface()]);
});
