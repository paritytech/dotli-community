// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The landing page's islands mounted in their slots: the page's document listener, the corner button, and what
// leaving takes with it. The controls are story plays beside NavForm and RecentList, and the static
// markup is Astro's, which the functional smoke test covers.

import { bindCaptureSink } from '@dotli/metrics';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAllStoresForTests } from '@dotli/shared/testing';
import { createMemorySharedChannel, type MemorySharedChannel } from '../../src/runtime/sharedMode.fake.js';
import { authState } from '../../src/runtime/state/authState.js';
import { createRecentLabels } from '../../src/createRecentLabels.js';
import { mountLandingPage } from '../helpers/landing.js';
import { appears, byId, query } from '@dotli/ui/testing';
import { setPageUrl } from '../happyDom.js';

const captures = { exception: vi.fn(), expected: vi.fn() };
bindCaptureSink(captures);

let page: ReturnType<typeof mountLandingPage> | null = null;
/** The cross-subdomain store the recents read and write. */
let shared: MemorySharedChannel;

function mount(): ReturnType<typeof mountLandingPage> {
  page = mountLandingPage({ recents: createRecentLabels({ channel: shared }) });
  return page;
}

/** Seeds the shared store with `labels` as the visitor's recent visits. */
function seedVisits(...labels: string[]): void {
  shared.store.set('dotli_recent', JSON.stringify(labels));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  setPageUrl('http://localhost:5173/');
  shared = createMemorySharedChannel();
  // A visitor not signed in, whose saved session has been read.
  authState.set({ tag: 'Disconnected' });
  localStorage.clear();
  captures.exception.mockClear();
  document.body.innerHTML = '';
});

afterEach(() => {
  page?.dispose();
  page = null;
  document.body.innerHTML = '';
  resetAllStoresForTests();
  vi.useRealTimers();
});

describe('landing page', () => {
  it("As a visitor, the page's document listener goes with it", async () => {
    // Given: the recent list's box, which its listener asks whether a press landed inside
    seedVisits('alpha');
    mount();
    await appears('[data-testid="landing-recent-item"]');
    const list = byId('dotli-recent');
    let asked = 0;
    const contains = list.contains.bind(list);
    list.contains = (node): boolean => {
      asked += 1;
      return contains(node);
    };
    document.dispatchEvent(new Event('pointerdown'));
    expect(asked).toBe(1);

    // When
    page?.dispose();
    page = null;
    document.dispatchEvent(new Event('pointerdown'));

    // Then
    expect(asked).toBe(1);
  });

  it("As a visitor, I can press the auth button in the page's corner", async () => {
    // When
    mount();
    await appears('#landing-auth-button');

    // Then
    expect(query(byId('landing-auth'), '#landing-auth-button', HTMLButtonElement).disabled).toBe(false);
    expect(captures.exception).not.toHaveBeenCalled();
  });
});
