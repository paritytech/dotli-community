// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One module per island, so Astro loads only this island's code when its directive fires.

import type { JSX } from '@solidjs/web';
import { useStore } from '@dotli/ui';
import { LoadingScreen as Screen } from '../components/loading/LoadingScreen.js';
import { loadingStore } from '../state/loading.js';
import { IslandBoundary } from './IslandBoundary.js';

/** The screen the host page paints first, bound to the loading store, so progress made before hydration shows. */
export function LoadingScreen(): JSX.Element {
  return (
    <IslandBoundary root="island:LoadingScreen">
      <Screen state={useStore(loadingStore)} />
    </IslandBoundary>
  );
}
