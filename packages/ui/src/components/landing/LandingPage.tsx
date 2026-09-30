// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Errored, lazy, Loading, onCleanup, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { captureException } from '@dotli/metrics';
import { registerAppRoot } from '../../mount/app-roots.js';
import { setLandingPage, topbarStore } from '../../state/topbar.js';
import { showError } from '../../ui.js';
import { useStore } from '../use-store.js';

/** The page itself, its own chunk, so the host's other pages never load it. */
const Landing = lazy(() => import('./Landing.js'), { export: 'Landing' });

/** The host's "reload" error page, for a landing page that cannot show. */
function showBroken(): void {
  showError('Something went wrong on our side', "This page didn't load properly. Reloading usually fixes it.", {
    label: 'Reload',
    onClick: () => {
      window.location.reload();
    },
  });
}

/**
 * The landing page island of the host page (`@dotli/ui/islands/LandingPage`),
 * beside `#app`: it renders the page while the topbar store says the landing
 * page is up (setLandingPage, from boot on the bare host), and nothing
 * otherwise. The page's chunk loads then, and the page replaces the loading
 * screen once it renders.
 *
 * While it shows it is the `"page"` app root, so whatever replaces the page
 * (an error page) disposes it, which takes the landing page down. A chunk
 * that cannot load, or a page that throws, is reported and replaced by the
 * error page, which offers a reload.
 */
export function LandingPage(): JSX.Element {
  const landing = useStore(topbarStore, state => state.landing);
  return (
    <Show when={landing()}>
      <Page />
    </Show>
  );
}

function Page(): JSX.Element {
  onCleanup(
    registerAppRoot('page', () => {
      setLandingPage(false);
    }),
  );
  return (
    <Errored
      fallback={err => {
        captureException(err(), { root: 'page' });
        showBroken();
        return null;
      }}
    >
      <Loading>
        <Landing />
      </Loading>
    </Errored>
  );
}
