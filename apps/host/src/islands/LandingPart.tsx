// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { useStore } from '@dotli/ui';
import { pageContentStore } from '@dotli/ui-widgets';
import { showBrokenPage } from '../broken-page.js';
import { IslandBoundary } from './IslandBoundary.js';

/**
 * Wraps each landing island. The page is nothing but these, so one failing breaks the whole page. A full-page screen
 * takes the page over, and the islands and their timers go with it.
 */
export function LandingPart(props: { children: JSX.Element }): JSX.Element {
  const shown = useStore(pageContentStore, content => content === 'page');
  return (
    <Show when={shown()}>
      <IslandBoundary root="page" onBroken={showBrokenPage}>
        {props.children}
      </IslandBoundary>
    </Show>
  );
}
