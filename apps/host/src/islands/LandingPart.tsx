// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { pageContentStore, RootBoundary, useStore } from '@dotli/ui';
import { showBrokenPage } from '../broken-page.js';

/**
 * Wraps each landing island. The page is nothing but these, so one failing breaks the whole page. A full-page screen
 * takes the page over, and the islands and their timers go with it.
 */
export function LandingPart(props: { children: JSX.Element; reload?: () => void }): JSX.Element {
  const shown = useStore(pageContentStore, content => content === 'page');
  return (
    <Show when={shown()}>
      <RootBoundary
        root="page"
        onBroken={() => {
          showBrokenPage(props.reload);
        }}
      >
        {props.children}
      </RootBoundary>
    </Show>
  );
}
