import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocaleSubscribe } from '../src/host-callbacks/Locale.js';
import { yielded } from './support.js';

const realLanguage = navigator.language;
const realTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

function setBrowserLanguage(tag: string): void {
  Object.defineProperty(navigator, 'language', {
    value: tag,
    configurable: true,
  });
}

afterEach(() => {
  setBrowserLanguage(realLanguage);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

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
    expect(yielded(first)._unsafeUnwrap()).toEqual({
      languageTag: 'pt-BR',
      timeZone: realTimeZone,
    });
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
    window.dispatchEvent(new Event('languagechange'));
    const changed = await next;

    await iterator.return?.();
    const afterReturn = await iterator.next();

    // Then
    expect(yielded(first)._unsafeUnwrap()).toEqual({
      languageTag: 'en',
      timeZone: realTimeZone,
    });
    expect(changed.done).toBe(false);
    expect(yielded(changed).isOk()).toBe(true);
    expect(yielded(changed)._unsafeUnwrap()).toEqual({
      languageTag: 'zh-Hans',
      timeZone: realTimeZone,
    });
    expect(afterReturn.done).toBe(true);
  });
  it.each(['focus', 'visibilitychange', 'timer'])(
    'updates the actual time zone on %s without repeating unchanged context',
    async signal => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
      let timeZone = 'America/New_York';
      const resolved = Intl.DateTimeFormat().resolvedOptions();
      vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(() => ({
        ...resolved,
        timeZone,
      }));
      const iterator = createLocaleSubscribe()()[Symbol.asyncIterator]();
      const initial = await iterator.next();
      expect(yielded(initial)._unsafeUnwrap().timeZone).toBe('America/New_York');
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
      vi.advanceTimersByTime(60_000);

      const pending = iterator.next();
      timeZone = 'Asia/Tokyo';
      if (signal === 'timer') {
        vi.advanceTimersByTime(60_000);
      } else if (signal === 'focus') {
        window.dispatchEvent(new Event('focus'));
      } else {
        document.dispatchEvent(new Event('visibilitychange'));
      }
      expect(yielded(await pending)._unsafeUnwrap().timeZone).toBe('Asia/Tokyo');

      const waiting = iterator.next();
      await iterator.return?.();
      expect((await waiting).done).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      timeZone = 'Europe/Berlin';
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('languagechange'));
      expect((await iterator.next()).done).toBe(true);
    },
  );

  it('reports unavailable timezone context as an error, not an invented UTC zone', async () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(() => {
      throw new Error('Timezone data unavailable');
    });
    const iterator = createLocaleSubscribe()()[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(yielded(first).isErr()).toBe(true);
    expect((await iterator.next()).done).toBe(true);
    await iterator.return?.();
  });
});
