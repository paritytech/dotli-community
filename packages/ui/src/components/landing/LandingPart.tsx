// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, createSignal, Errored, onSettled, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { captureException } from '@dotli/metrics';
import { showBrokenPage } from '../../ui.js';
import { joinLandingRoot } from './landing-root.js';

/**
 * Wraps each landing island. The page is nothing but these, so one failing breaks the whole page, and an error page
 * disposes them together.
 */
export function LandingPart(props: { children: JSX.Element }): JSX.Element {
  const [shown, setShown] = createSignal(true);
  onSettled(() => joinLandingRoot(() => setShown(false)));
  return (
    <Show when={shown()}>
      <Errored fallback={err => <Broken error={err()} />}>{props.children}</Errored>
    </Show>
  );
}

function Broken(props: { error: unknown }): JSX.Element {
  createEffect(
    () => props.error,
    error => {
      captureException(error, { flow: 'ui', step: 'root_render', tags: { root: 'page' } });
      showBrokenPage();
    },
  );
  return null;
}
