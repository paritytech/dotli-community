// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, expect } from 'vitest';
import { page } from 'vitest/browser';
import { configure } from 'storybook/test';

// Vite transforms each lazy chunk on first request, which on a shared CI
// runner outlasts waitFor's 1 s default; a real failure still fails, later.
configure({ asyncUtilTimeout: 5000 });

// Stories whose capture is not stable run to run (a spinner, a caret), by
// story id, each with the reason. addon-vitest exposes only `storyId` on the
// test task (task.meta), not the story's tags or parameters, so an opt-out is
// listed here rather than on the story. Empty while every capture is stable.
const UNSTABLE = new Set<string>();

// Local refactor check only (VRT=1): the whole viewport, since the surfaces
// are fixed and portalled outside the story root. (An element locator cannot
// target <html>, so the page is captured.)
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
