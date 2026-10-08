// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { flush } from 'solid-js';
import { render } from '@solidjs/web';
import { LandingAuth } from '../../src/components/landing/LandingAuth.js';
import { LandingNav } from '../../src/components/landing/LandingNav.js';
import { LandingRecents } from '../../src/components/landing/LandingRecents.js';

/**
 * Renders the landing page's islands into the slots apps/host/src/components/Landing.astro gives them, in a fresh
 * `#app-view`. The caller mocks `@dotli/ui/recent-labels`, whose storage frame happy-dom would try to fetch.
 */
export function mountLandingPage(): {
  view: HTMLElement;
  dispose: () => void;
} {
  const view = document.createElement('div');
  view.id = 'app-view';
  view.innerHTML =
    '<div data-testid="landing"><div id="landing-auth"></div><div data-slot="content"><div data-slot="nav"></div><div data-slot="recents"></div></div></div>';
  document.body.append(view);
  const slot = (selector: string): Element => {
    const el = view.querySelector(selector);
    if (el === null) {
      throw new Error(`No ${selector} slot`);
    }
    return el;
  };
  const unmounts = [
    render(() => <LandingAuth />, slot('#landing-auth')),
    render(() => <LandingNav />, slot('[data-slot="nav"]')),
    render(() => <LandingRecents />, slot('[data-slot="recents"]')),
  ];
  flush();
  return {
    view,
    dispose: () => {
      for (const unmount of unmounts) {
        unmount();
      }
      view.remove();
    },
  };
}
