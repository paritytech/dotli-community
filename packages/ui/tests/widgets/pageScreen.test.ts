// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetAllStoresForTests } from '@dotli/shared/testing';
import { createComponent, onCleanup } from 'solid-js';
import { render } from '@solidjs/web';
import { toasts } from '../../src/page/state/createToasts.js';
import { byTestId, settle } from '../../src/testing/index.js';
import { BellIcon } from '../../src/icons.js';
import { Overlays } from '../../src/widgets/overlays/Overlays.js';
import { createPageScreen } from '../../src/widgets/createPageScreen.js';

/** The views taken down, by test id. */
let disposed: string[] = [];

/** A screen's view, as plain markup a test can find, that records its disposal. */
function renderScreen(testId: string): HTMLElement {
  onCleanup(() => disposed.push(testId));
  const element = document.createElement('p');
  element.dataset['testid'] = testId;
  element.textContent = testId;
  return element;
}

let disposeOverlays: (() => void) | undefined;
let pageScreen: ReturnType<typeof createPageScreen>;

beforeEach(() => {
  pageScreen = createPageScreen({ page: document });
});

afterEach(() => {
  disposeOverlays?.();
  disposeOverlays = undefined;
  resetAllStoresForTests();
  document.body.replaceChildren();
  disposed = [];
});

describe('page screen', () => {
  it("As a visitor, I see a full-page screen take the place of the page's content, and a later one take its place in turn", () => {
    // Given
    document.body.innerHTML = '<div id="app"><iframe data-testid="frame"></iframe></div>';

    // When
    pageScreen.show(() => renderScreen('first'));
    pageScreen.show(() => renderScreen('second'));

    // Then
    expect(document.querySelector('[data-testid="frame"]')).toBeNull();
    expect(document.querySelector('[data-testid="first"]')).toBeNull();
    expect(byTestId('second').textContent).toBe('second');
    expect(disposed).toEqual(['first']);
    expect(pageScreen.store.get()).toBe('screen');
  });

  it('As the shell, I clear the screen and it goes, and what the page put in #app since stays', () => {
    // Given
    document.body.innerHTML = '<div id="app"></div>';
    pageScreen.show(() => renderScreen('error'));
    const frame = document.createElement('iframe');
    document.getElementById('app')?.append(frame);

    // When
    pageScreen.clear();

    // Then
    expect(document.querySelector('[data-testid="error"]')).toBeNull();
    expect(frame.isConnected).toBe(true);
    expect(pageScreen.store.get()).toBe('page');
  });

  it('As a page that ends, I dispose the screen slot and the shown screen is taken down once', () => {
    // Given: a screen is shown.
    document.body.innerHTML = '<div id="app"></div>';
    pageScreen.show(() => renderScreen('first'));

    // When: the page ends and disposes the slot twice.
    pageScreen.dispose();
    pageScreen.dispose();

    // Then: the view went down once and the page's own content is back.
    expect(disposed).toEqual(['first']);
    expect(pageScreen.store.get()).toBe('page');
  });

  it('As a page with no #app, I show a screen and it fills the body and is told it stands alone', () => {
    // Given
    document.body.innerHTML = '<main data-testid="landing"></main>';
    let standalone: boolean | undefined;

    // When
    pageScreen.show(alone => {
      standalone = alone;
      return renderScreen('error');
    });

    // Then
    expect(standalone).toBe(true);
    expect(document.querySelector('[data-testid="landing"]')).toBeNull();
    expect(byTestId('error').textContent).toBe('error');
  });

  it('As a visitor on a page with no #app, I get a toast after a full-page screen took the body and still see it', async () => {
    // Given: the overlays mounted in the container the page marks as theirs, beside the page's own content.
    document.body.innerHTML = '<main data-testid="landing"></main>';
    const host = document.createElement('div');
    host.dataset['overlays'] = '';
    document.body.append(host);
    disposeOverlays = render(() => createComponent(Overlays, {}), host);
    pageScreen.show(() => renderScreen('error'));

    // When
    toasts.push({ text: 'A new version may have been deployed', label: 'Reload', icon: BellIcon, dismissMs: 0 });
    await settle();

    // Then
    expect(document.querySelector('[data-testid="landing"]')).toBeNull();
    expect(host.isConnected).toBe(true);
    expect(byTestId('notif-title').textContent).toBe('Reload');
  });
});
