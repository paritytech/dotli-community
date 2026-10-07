// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { flush } from 'solid-js';
import { render } from '@solidjs/web';
import { Landing } from '../../src/components/landing/Landing.js';

/**
 * Renders the real landing page into a fresh `#app-view`. The caller mocks `@dotli/ui/recent-labels`, whose storage
 * frame happy-dom would try to fetch.
 */
export function mountLandingPage(): {
  view: HTMLElement;
  dispose: () => void;
} {
  const view = document.createElement('div');
  view.id = 'app-view';
  document.body.append(view);
  const unmount = render(() => <Landing />, view);
  flush();
  return {
    view,
    dispose: () => {
      unmount();
      view.remove();
    },
  };
}
