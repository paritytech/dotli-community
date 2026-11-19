// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The landing page's islands mounted in their slots: the recent names in the name input's suggestions, read from and
// forgotten in the shared store, and the header's auth button. The controls are story plays beside NavForm and Suggestions, and
// the static markup is Astro's, which the functional smoke test covers.

import { flush } from 'solid-js';
import { bindCaptureSink } from '@dotli/metrics';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAllStoresForTests, waitForDom } from '@dotli/shared/testing';
import { createMemorySharedChannel, type MemorySharedChannel } from '../../../../kit/sharedMode.fake.js';
import { authState } from '../../../account/session/authState.js';
import { createRecentLabels } from '../../createRecentLabels.js';
import { mountLandingPage } from '../../../../../tests/helpers/landing.js';
import { appears, byId, query } from '@dotli/ui/testing';
import { setPageUrl } from '../../../../../tests/happyDom.js';

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

/** Focuses the empty name input once it is enabled, and resolves with it once the recent names show. */
async function focusForRecents(): Promise<HTMLInputElement> {
  const input = byId('dotli-nav-input', HTMLInputElement);
  await waitForDom(() => !input.disabled);
  input.focus();
  await appears('[role="group"] [role="option"]');
  return input;
}

/** The names the suggestions show under their Recent heading, each without its TLD. */
function recentShown(): (string | undefined)[] {
  const group = query(document, '[role="group"]');
  return [...group.querySelectorAll('[role="option"]')].map(option => option.textContent.split('.')[0]);
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
  it('As a returning visitor, I focus the empty name input and see my recent names from the shared store, newest first', async () => {
    // Given
    seedVisits('alpha', 'beta');
    mount();

    // When
    await focusForRecents();

    // Then
    expect(recentShown()).toEqual(['alpha', 'beta']);
  });

  it('As a returning visitor, I click the cross on a recent name and the shared store forgets it', async () => {
    // Given
    seedVisits('alpha', 'beta');
    mount();
    await focusForRecents();

    // When
    query(document, '[role="option"] [data-testid="listbox-remove"]').click();

    // Then
    await vi.waitFor(() => {
      expect(shared.store.get('dotli_recent')).toBe('["beta"]');
    });
  });

  it('As a returning visitor, I press Shift+Delete on the active recent name and the shared store forgets it', async () => {
    // Given the first recent name active
    seedVisits('alpha', 'beta');
    mount();
    const input = await focusForRecents();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    flush();

    // When
    const shiftDelete = new KeyboardEvent('keydown', {
      key: 'Delete',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(shiftDelete);

    // Then the key was taken from the input, and the name forgotten
    expect(shiftDelete.defaultPrevented).toBe(true);
    await vi.waitFor(() => {
      expect(shared.store.get('dotli_recent')).toBe('["beta"]');
    });
  });

  it("As a visitor, I can press the auth button in the page's header", async () => {
    // When
    mount();
    await appears('#landing-auth-button');

    // Then
    expect(query(byId('landing-auth'), '#landing-auth-button', HTMLButtonElement).disabled).toBe(false);
    expect(captures.exception).not.toHaveBeenCalled();
  });
});
