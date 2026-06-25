import { beforeEach, describe, expect, it } from "vitest";
import { createThemeSubscribe } from "@dotli/ui/host-callbacks/Theme";

describe("theme host callbacks", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("data-theme");
  });

  it("emits the current theme immediately", async () => {
    document.documentElement.setAttribute("data-theme", "light");
    const subscribeTheme = createThemeSubscribe();

    const iterator = subscribeTheme()[Symbol.asyncIterator]();
    const first = await iterator.next();
    await iterator.return?.();

    expect(first.done).toBe(false);
    expect(first.value.isOk()).toBe(true);
    expect(first.value._unsafeUnwrap()).toBe("Light");
  });

  it("emits theme changes until unsubscribed", async () => {
    document.documentElement.setAttribute("data-theme", "dark");
    const subscribeTheme = createThemeSubscribe();

    const iterator = subscribeTheme()[Symbol.asyncIterator]();
    const first = await iterator.next();
    const next = iterator.next();

    document.documentElement.setAttribute("data-theme", "light");
    window.dispatchEvent(new Event("dotli:theme-changed"));
    const changed = await next;

    await iterator.return?.();
    const afterReturn = await iterator.next();

    expect(first.done).toBe(false);
    expect(first.value.isOk()).toBe(true);
    expect(first.value._unsafeUnwrap()).toBe("Dark");
    expect(changed.done).toBe(false);
    expect(changed.value.isOk()).toBe(true);
    expect(changed.value._unsafeUnwrap()).toBe("Light");
    expect(afterReturn.done).toBe(true);
  });
});
