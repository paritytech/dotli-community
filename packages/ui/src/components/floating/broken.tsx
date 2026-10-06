// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { captureException } from '@dotli/metrics';

/**
 * A surface's content that failed (a `lazy()` chunk gone after a deploy, or
 * a throw): reported once under `root` (`popover:<id>`, `tooltip:<id>`),
 * then `fail` closes the surface. Its own module, so Tooltip does not pull
 * the sheet into its chunk.
 */
export function Broken(props: { root: string; error: unknown; fail: () => void }): JSX.Element {
  createEffect(
    () => props.error,
    error => {
      captureException(error, { flow: 'ui', step: 'root_render', tags: { root: props.root } });
      props.fail();
    },
  );
  return null;
}
