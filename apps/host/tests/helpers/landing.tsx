// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { flush } from 'solid-js';
import { render } from '@solidjs/web';
import { LandingAuth } from '../../src/islands/LandingAuth.js';
import { LandingNav } from '../../src/islands/LandingNav.js';
import { LandingRecents } from '../../src/islands/LandingRecents.js';
import type { RecentLabels } from '../../src/createRecentLabels.js';

type Params = {
  /** Where the recents come from, since the page's own read the storage frame, which happy-dom would try to fetch. */
  recents: RecentLabels;
};

/** Renders the landing page's islands into the slots the landing markup gives them, in a fresh `#app-view`. */
export function mountLandingPage({ recents }: Params) {
  const view = document.createElement('div');
  view.id = 'app-view';
  view.innerHTML =
    '<div data-testid="landing"><div id="landing-auth"></div><div data-slot="content"><div data-slot="nav"></div><div data-slot="recents"></div></div></div>';
  document.body.append(view);
  const unmounts = [
    render(() => <LandingAuth />, findSlot('#landing-auth')),
    render(() => <LandingNav />, findSlot('[data-slot="nav"]')),
    render(() => <LandingRecents recents={recents} />, findSlot('[data-slot="recents"]')),
  ];
  flush();
  return {
    /** The view the islands render in, on the page until `dispose` runs. */
    view,
    /** Unmounts every island and takes the view off the page. */
    dispose() {
      for (const unmount of unmounts) {
        unmount();
      }
      view.remove();
    },
  };

  function findSlot(selector: string): Element {
    const slot = view.querySelector(selector);
    if (slot === null) {
      throw new Error(`No ${selector} slot`);
    }
    return slot;
  }
}
