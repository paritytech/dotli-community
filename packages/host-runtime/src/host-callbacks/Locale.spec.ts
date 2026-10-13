// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { yielded } from '../testing/fixtures.js';
import { createLocaleSubscribe as createPageLocaleSubscribe } from './Locale.js';

let language = 'en';
const page = new EventTarget();

function setBrowserLanguage(tag: string): void {
  language = tag;
}

/** The locale stream over a browser whose language the test sets. */
function createLocaleSubscribe(): ReturnType<typeof createPageLocaleSubscribe> {
  return createPageLocaleSubscribe({ language: () => language, events: () => page });
}

describe('locale host callbacks', () => {
  it("As a dotli integrator, the host emits the visitor's language immediately", async () => {
    // Given
    // dotli presents English chrome, but a product localizes itself, so the
    // signal has to be what the visitor asked their browser for.
    setBrowserLanguage('pt-BR');
    const subscribeLocale = createLocaleSubscribe();

    // When
    const iterator = subscribeLocale()[Symbol.asyncIterator]();
    const first = await iterator.next();
    await iterator.return?.();

    // Then
    expect(first.done).toBe(false);
    expect(yielded(first).isOk()).toBe(true);
    expect(yielded(first)._unsafeUnwrap()).toEqual({ languageTag: 'pt-BR' });
  });

  it('As a dotli integrator, the host emits language changes until unsubscribed', async () => {
    // Given
    setBrowserLanguage('en');
    const subscribeLocale = createLocaleSubscribe();

    const iterator = subscribeLocale()[Symbol.asyncIterator]();
    const first = await iterator.next();
    const next = iterator.next();

    // When
    setBrowserLanguage('zh-Hans');
    page.dispatchEvent(new Event('languagechange'));
    const changed = await next;

    await iterator.return?.();
    const afterReturn = await iterator.next();

    // Then
    expect(yielded(first)._unsafeUnwrap()).toEqual({ languageTag: 'en' });
    expect(changed.done).toBe(false);
    expect(yielded(changed).isOk()).toBe(true);
    expect(yielded(changed)._unsafeUnwrap()).toEqual({
      languageTag: 'zh-Hans',
    });
    expect(afterReturn.done).toBe(true);
  });
});
