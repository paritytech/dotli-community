// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, Errored, lazy, Loading, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { captureException } from '@dotli/metrics';
import { topbarStore } from '../../state/topbar.js';
import { showBrokenPage } from '../../ui.js';
import { useStore } from '../use-store.js';

/** The page itself, its own chunk, so the host's other pages never load it. */
const Landing = lazy(() => import('./Landing.js'), { export: 'Landing' });

/**
 * The landing page island of the host page (`@dotli/ui/islands/LandingPage`),
 * beside `#app`: it renders the page while the topbar store says the landing
 * page is up (setLandingPage, from boot on the bare host), and nothing
 * otherwise. It waits for the topbar's action group to hydrate, whose
 * build-time account and theme buttons carry the ids of the page's own. The
 * page's chunk loads then, and the page replaces the loading screen once it
 * renders.
 *
 * An error page takes the landing page down (it clears the flag). A chunk
 * that cannot load, or a page that throws, is reported and replaced by the
 * reload error page.
 */
export function LandingPage(): JSX.Element {
  const shown = useStore(topbarStore, state => state.landing && state.actionsLive);
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

/** Reports the page's failure and shows the reload error page, after it renders. */
function Broken(props: { error: unknown }): JSX.Element {
  createEffect(
    () => props.error,
    error => {
      captureException(error, { root: 'page' });
      showBrokenPage();
    },
  );
  return null;
}
