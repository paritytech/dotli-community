// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, Errored, lazy, Loading, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { captureException } from '@dotli/metrics';
import { topbarStore } from '../../state/topbar.js';
import { showBrokenPage } from '../../ui.js';
import { useStore } from '../use-store.js';

/** Its own chunk, so the host's other pages never load it. */
const Landing = lazy(() => import('./Landing.js'), { export: 'Landing' });

/** Island that renders the landing page while the topbar store's `landing` flag is set. An error page clears it. */
export function LandingPage(): JSX.Element {
  const shown = useStore(topbarStore, state => state.landing);
  return (
    <Show when={shown()}>
      <Errored fallback={err => <Broken error={err()} />}>
        <Loading>
          <Landing />
        </Loading>
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
