// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { captureException } from '@dotli/metrics';

/**
 * Reports a surface's failed content (a chunk gone after a deploy, or a throw) once, then closes it via `fail`.
 * Its own module so Tooltip doesn't pull the sheet into its chunk.
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
