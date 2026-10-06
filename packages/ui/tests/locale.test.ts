import { afterEach, expect, it, vi } from "vitest";
import { ok } from "neverthrow";
import { createLocaleSubscribe } from "@dotli/ui/host-callbacks/Locale";

afterEach(() => vi.restoreAllMocks());

it("streams the browser locale and later changes until disposed", async () => {
  vi.spyOn(navigator, "language", "get").mockReturnValue("en-GB");
  const subscription = createLocaleSubscribe()()[Symbol.asyncIterator]();
  const initial = await subscription.next();
  vi.spyOn(navigator, "language", "get").mockReturnValue("fr-FR");
  window.dispatchEvent(new Event("languagechange"));
  const changed = await subscription.next();
  await subscription.return?.();
  window.dispatchEvent(new Event("languagechange"));
  expect([initial, changed, await subscription.next()]).toEqual([
    { done: false, value: ok({ languageTag: "en-GB" }) },
    { done: false, value: ok({ languageTag: "fr-FR" }) },
    { done: true, value: undefined },
  ]);
});
