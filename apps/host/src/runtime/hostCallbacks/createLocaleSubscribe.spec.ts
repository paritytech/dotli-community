// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import { yielded } from '../../testing/fixtures.js';
import { createLocaleSubscribe } from './createLocaleSubscribe.js';

describe('locale host callbacks', () => {
  it("As a dotli integrator, I subscribe to the locale and get the visitor's language at once", async () => {
    // Given
    // dotli presents English chrome, but a product localizes itself, so the
    // signal has to be what the visitor asked their browser for.
    const browser = createFakeBrowser('pt-BR');
    const iterator = browser.subscribeLocale()[Symbol.asyncIterator]();
    onTestFinished(async () => {
      await iterator.return?.();
    });

    // When
    const first = await iterator.next();

    // Then
    expect(yielded(first)._unsafeUnwrap()).toEqual({ languageTag: 'pt-BR' });
  });

  it('As a dotli integrator, I subscribe to the locale and hear each language change until I unsubscribe', async () => {
    // Given
    const browser = createFakeBrowser('en');
    const iterator = browser.subscribeLocale()[Symbol.asyncIterator]();
    const first = await iterator.next();
    const next = iterator.next();

    // When
    browser.changeLanguage('zh-Hans');
    const changed = await next;
    await iterator.return?.();
    const afterReturn = await iterator.next();

    // Then
    expect([first, changed].map(step => yielded(step)._unsafeUnwrap())).toEqual([
      { languageTag: 'en' },
      { languageTag: 'zh-Hans' },
    ]);
    expect(afterReturn.done).toBe(true);
  });
});

/** The locale stream over a browser whose language the test changes. */
function createFakeBrowser(initial: string) {
  let language = initial;
  const page = new EventTarget();
  return {
    /** The locale stream over this browser. */
    subscribeLocale: createLocaleSubscribe({ language: () => language, events: () => page }),
    /** Sets the browser's language and fires `languagechange`. */
    changeLanguage(tag: string): void {
      language = tag;
      page.dispatchEvent(new Event('languagechange'));
    },
  };
}
