// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, createSignal, Errored, onSettled, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { captureException } from '@dotli/metrics';
import { registerAppRoot } from '../../mount/app-roots.js';
import { showBrokenPage } from '../../ui.js';
import { Landing } from './Landing.js';

/** Island for the landing page. It is the page's root, so an error page disposes it to take the page over. */
export function LandingPage(): JSX.Element {
  const [shown, setShown] = createSignal(true);
  onSettled(() => {
    registerAppRoot('page', () => setShown(false));
  });
  return (
    <Show when={shown()}>
      <Errored fallback={err => <Broken error={err()} />}>
        <Landing />
      </Errored>
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
