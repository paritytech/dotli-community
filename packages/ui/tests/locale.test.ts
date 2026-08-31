import { afterEach, describe, expect, it } from "vitest";
import { createLocaleSubscribe } from "@dotli/ui/host-callbacks/Locale";

const realLanguage = navigator.language;

function setBrowserLanguage(tag: string): void {
  Object.defineProperty(navigator, "language", {
    value: tag,
    configurable: true,
  });
}

afterEach(() => {
  setBrowserLanguage(realLanguage);
});

describe("locale host callbacks", () => {
  it("As a dotli integrator, the host emits the visitor's language immediately", async () => {
    // Given
    // dotli presents English chrome, but a product localizes itself, so the
    // signal has to be what the visitor asked their browser for.
    setBrowserLanguage("pt-BR");
    const subscribeLocale = createLocaleSubscribe();

    // When
    const iterator = subscribeLocale()[Symbol.asyncIterator]();
    const first = await iterator.next();
    await iterator.return?.();

    // Then
    expect(first.done).toBe(false);
    expect(first.value.isOk()).toBe(true);
    expect(first.value._unsafeUnwrap()).toEqual({ languageTag: "pt-BR" });
  });

  it("As a dotli integrator, the host emits language changes until unsubscribed", async () => {
    // Given
    setBrowserLanguage("en");
    const subscribeLocale = createLocaleSubscribe();

    const iterator = subscribeLocale()[Symbol.asyncIterator]();
    const first = await iterator.next();
    const next = iterator.next();

    // When
    setBrowserLanguage("zh-Hans");
    window.dispatchEvent(new Event("languagechange"));
    const changed = await next;

    await iterator.return?.();
    const afterReturn = await iterator.next();

    // Then
    expect(first.value._unsafeUnwrap()).toEqual({ languageTag: "en" });
    expect(changed.done).toBe(false);
    expect(changed.value.isOk()).toBe(true);
    expect(changed.value._unsafeUnwrap()).toEqual({ languageTag: "zh-Hans" });
    expect(afterReturn.done).toBe(true);
  });
});
