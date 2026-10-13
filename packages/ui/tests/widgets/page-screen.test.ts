// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { createComponent, onCleanup } from 'solid-js';
import { render } from '@solidjs/web';
import { pushToast } from '../../src/page/state/toasts.js';
import { byTestId, resetToastsForTests, settle } from '../../src/testing/index.js';
import { BellIcon } from '../../src/icons.js';
import { Overlays } from '../../src/widgets/overlays/Overlays.js';
import { clearScreen, pageContentStore, showScreen } from '../../src/widgets/page-screen.js';

/** The views taken down, by test id. */
let disposed: string[] = [];

/** A screen's view, as plain markup a test can find, that records its disposal. */
function screen(testId: string): HTMLElement {
  onCleanup(() => disposed.push(testId));
  const el = document.createElement('p');
  el.dataset['testid'] = testId;
  el.textContent = testId;
  return el;
}

let disposeOverlays: (() => void) | undefined;

afterEach(() => {
  clearScreen();
  disposeOverlays?.();
  disposeOverlays = undefined;
  resetToastsForTests();
  document.body.replaceChildren();
  disposed = [];
});

describe('page screen', () => {
  it("As a visitor, a full-page screen takes the place of the page's content, and a later one takes its place in turn", () => {
    // Given
    document.body.innerHTML = '<div id="app"><iframe data-testid="frame"></iframe></div>';

    // When
    showScreen(() => screen('first'));
    showScreen(() => screen('second'));

    // Then
    expect(document.querySelector('[data-testid="frame"]')).toBeNull();
    expect(document.querySelector('[data-testid="first"]')).toBeNull();
    expect(byTestId('second').textContent).toBe('second');
    expect(disposed).toEqual(['first']);
    expect(pageContentStore.get()).toBe('screen');
  });

  it('As the shell, clearing the screen takes it down and keeps what the page put in #app since', () => {
    // Given
    document.body.innerHTML = '<div id="app"></div>';
    showScreen(() => screen('error'));
    const frame = document.createElement('iframe');
    document.getElementById('app')?.append(frame);

    // When
    clearScreen();

    // Then
    expect(document.querySelector('[data-testid="error"]')).toBeNull();
    expect(frame.isConnected).toBe(true);
    expect(pageContentStore.get()).toBe('page');
  });

  it('As a page with no #app, a screen fills the body and is told it stands alone', () => {
    // Given
    document.body.innerHTML = '<main data-testid="landing"></main>';
    let standalone: boolean | undefined;

    // When
    showScreen(alone => {
      standalone = alone;
      return screen('error');
    });

    // Then
    expect(standalone).toBe(true);
    expect(document.querySelector('[data-testid="landing"]')).toBeNull();
    expect(byTestId('error').textContent).toBe('error');
  });

  it('As a visitor on a page with no #app, I still see a toast raised after a full-page screen took the body', async () => {
    // Given: the overlays mounted in the container the page marks as theirs, beside the page's own content.
    document.body.innerHTML = '<main data-testid="landing"></main>';
    const host = document.createElement('div');
    host.dataset['overlays'] = '';
    document.body.append(host);
    disposeOverlays = render(() => createComponent(Overlays, {}), host);
    showScreen(() => screen('error'));

    // When
    pushToast({ text: 'A new version may have been deployed', label: 'Reload', icon: BellIcon, dismissMs: 0 });
    await settle();

    // Then
    expect(document.querySelector('[data-testid="landing"]')).toBeNull();
    expect(host.isConnected).toBe(true);
    expect(byTestId('notif-title').textContent).toBe('Reload');
  });
});
