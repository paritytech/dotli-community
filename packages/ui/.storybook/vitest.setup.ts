// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, expect } from 'vitest';
import { page } from 'vitest/browser';
import { configure } from 'storybook/test';

// Vite transforms each lazy chunk on first request, which on a shared CI runner outlasts waitFor's 1 s default.
configure({ asyncUtilTimeout: 5000 });

// Story ids whose capture is not stable run to run, each with its reason. addon-vitest exposes
// only `storyId` on the test task, not tags or parameters, so the opt-out lives here.
const UNSTABLE = new Set<string>();

// Local refactor check only (VRT=1). Captures the page because surfaces are portalled outside the story root.
afterEach(async ({ task }) => {
  if (import.meta.env['VITE_VRT'] !== '1' || task.result?.state === 'fail') {
    return;
  }
  // addon-vitest adds `storyId` to the meta, which TaskMeta does not declare.
  const { storyId } = task.meta as { storyId?: string };
  if (storyId !== undefined && UNSTABLE.has(storyId)) {
    return;
  }
  await expect(page).toMatchScreenshot(task.name);
});
