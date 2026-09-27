// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPopover,
  type PopoverMode,
  type PopoverOptions,
} from "@dotli/ui/components/shell/popover";
import { setBlockingModalActive } from "@dotli/ui/state/topbar";
import { renderComponent, resetStores, settle } from "../../helpers/solid";

type Popover = ReturnType<typeof createPopover>;

type HarnessOptions = Omit<PopoverOptions, "trigger" | "surface" | "mode">;

/**
 * A trigger, a surface, and a button outside both. The popover and dialog
 * surfaces hold two buttons; the menu surface holds menu items (one of them
 * hidden) and no tabbable element. `empty` renders a surface with nothing
 * focusable in it. The trigger has no click handler of its own, so a click
 * on it tests only what the popover does with it.
 */
function renderPopover(
  mode: PopoverMode,
  options: HarnessOptions = {},
  { empty = false }: { empty?: boolean } = {},
): Popover & { unmount: () => void } {
  let popover: Popover | undefined;
  function Harness() {
    let trigger: HTMLButtonElement | undefined;
    let surface: HTMLDivElement | undefined;
    popover = createPopover({
      ...options,
      mode,
      trigger: () => trigger,
      surface: () => surface,
    });
    const content = () => {
      if (empty) {
        return <span id="text">Text</span>;
      }
      if (mode === "menu") {
        return (
          <>
            <button id="apple" role="menuitem" tabindex="-1">
              Apple
            </button>
            <button id="hidden-item" role="menuitem" tabindex="-1" hidden>
              Hidden
            </button>
            <button id="banana" role="menuitemradio" tabindex="-1">
              Banana
            </button>
            <button id="avocado" role="menuitem" tabindex="-1">
              Avocado
            </button>
            <button id="cherry" role="menuitem" tabindex="-1">
              Cherry
            </button>
          </>
        );
      }
      return (
        <>
          <button id="first" type="button">
            First
          </button>
          <button id="last" type="button">
            Last
          </button>
        </>
      );
    };
    return (
      <div>
        <button
          id="trigger"
          type="button"
          ref={(el) => {
            trigger = el;
          }}
        >
          <span id="trigger-icon">T</span>
        </button>
        <div
          id="surface"
          tabindex="-1"
          ref={(el) => {
            surface = el;
          }}
        >
          {content()}
        </div>
        <button id="outside" type="button">
          Outside
        </button>
      </div>
    );
  }
  const { unmount } = renderComponent(() => <Harness />);
  return { ...(popover as Popover), unmount };
}

function byId(id: string): HTMLElement {
  return document.getElementById(id) as HTMLElement;
}

async function openPopover(popover: Popover): Promise<void> {
  popover.setOpen(true);
  await settle();
  expect(popover.open()).toBe(true);
}

function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  (document.activeElement ?? document.body).dispatchEvent(event);
  return event;
}

/**
 * A mouse press on `el`: pointerdown, then (as a browser does, moving focus
 * on mousedown) focus when `el` takes it, then the click. Returns the click,
 * and whether it reached `el`'s own listeners.
 */
function pointerClick(el: HTMLElement): {
  click: MouseEvent;
  reached: boolean;
} {
  el.dispatchEvent(
    new PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      pointerType: "mouse",
      button: 0,
    }),
  );
  if (el instanceof HTMLButtonElement) {
    el.focus();
  }
  let reached = false;
  const onClick = (): void => {
    reached = true;
  };
  el.addEventListener("click", onClick);
  const click = new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    detail: 1,
  });
  el.dispatchEvent(click);
  el.removeEventListener("click", onClick);
  return { click, reached };
}

afterEach(() => {
  resetStores();
  document.body.style.overflow = "";
  vi.restoreAllMocks();
});

describe("createPopover, in every mode", () => {
  it.each<PopoverMode>(["popover", "menu", "dialog"])(
    "As a user, the trigger toggles the %s open and closed",
    async (mode) => {
      // Given
      const popover = renderPopover(mode);
      expect(popover.open()).toBe(false);

      // When / Then
      popover.toggle();
      await settle();
      expect(popover.open()).toBe(true);
      popover.toggle();
      await settle();
      expect(popover.open()).toBe(false);
    },
  );

  it.each<PopoverMode>(["popover", "menu", "dialog"])(
    "As a user, a press inside the %s or on the trigger leaves it open",
    async (mode) => {
      // Given
      const popover = renderPopover(mode);
      await openPopover(popover);

      // When
      byId("surface").dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true }),
      );
      byId("trigger-icon").dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true }),
      );
      byId("surface").click();
      await settle();

      // Then
      expect(popover.open()).toBe(true);
    },
  );

  it.each<PopoverMode>(["popover", "dialog"])(
    "As a keyboard user, opening a %s focuses its first tabbable element",
    async (mode) => {
      // Given
      const popover = renderPopover(mode);
      byId("trigger").focus();

      // When
      await openPopover(popover);

      // Then
      expect(document.activeElement).toBe(byId("first"));
    },
  );

  it.each<PopoverMode>(["popover", "dialog"])(
    "As a keyboard user, opening a %s with nothing tabbable in it focuses the surface itself",
    async (mode) => {
      // Given
      const popover = renderPopover(mode, {}, { empty: true });
      byId("trigger").focus();

      // When
      await openPopover(popover);

      // Then
      expect(document.activeElement).toBe(byId("surface"));
    },
  );

  it.each<PopoverMode>(["popover", "menu", "dialog"])(
    "As a keyboard user, Escape closes the %s and hands focus back to the trigger",
    async (mode) => {
      // Given
      const popover = renderPopover(mode);
      await openPopover(popover);
      expect(byId("surface").contains(document.activeElement)).toBe(true);

      // When
      press("Escape");
      await settle();

      // Then
      expect(popover.open()).toBe(false);
      expect(document.activeElement).toBe(byId("trigger"));
    },
  );

  it("As a Safari user, whose focus stays on the body after a click, Escape hands focus back to the trigger", async () => {
    // Given
    const popover = renderPopover("popover");
    await openPopover(popover);
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);

    // When
    press("Escape");
    await settle();

    // Then
    expect(popover.open()).toBe(false);
    expect(document.activeElement).toBe(byId("trigger"));
  });

  it("As a keyboard user, Escape leaves the popover open, and focus alone, while shouldHandleEscape says something inside consumes it", async () => {
    // Given: something inside (a row's dropdown) is open, then closes.
    let inner = true;
    const popover = renderPopover("popover", {
      shouldHandleEscape: () => !inner,
    });
    await openPopover(popover);
    byId("last").focus();

    // When
    const consumed = press("Escape");
    await settle();

    // Then
    expect(popover.open()).toBe(true);
    expect(document.activeElement).toBe(byId("last"));
    expect(consumed.defaultPrevented).toBe(false);

    // When
    inner = false;
    press("Escape");
    await settle();

    // Then
    expect(popover.open()).toBe(false);
    expect(document.activeElement).toBe(byId("trigger"));
  });

  it("As a keyboard user, Escape still closes a popover whose surface is not rendered", async () => {
    // Given
    let popover: Popover | undefined;
    renderComponent(() => {
      popover = createPopover({
        mode: "popover",
        trigger: () => undefined,
        surface: () => undefined,
      });
      return null;
    });
    await openPopover(popover as Popover);

    // When
    press("Escape");
    await settle();

    // Then
    expect(popover?.open()).toBe(false);
  });

  it.each<PopoverMode>(["popover", "menu", "dialog"])(
    "As a user, a blocking modal coming up closes the %s",
    async (mode) => {
      // Given
      const popover = renderPopover(mode);
      await openPopover(popover);

      // When
      setBlockingModalActive(true);
      await settle();

      // Then
      expect(popover.open()).toBe(false);
    },
  );

  it("As a user, a popover opened while a blocking modal is already up stays open until another one comes up", async () => {
    // Given
    setBlockingModalActive(true);
    const popover = renderPopover("popover");

    // When
    await openPopover(popover);

    // Then
    expect(popover.open()).toBe(true);
    setBlockingModalActive(false);
    await settle();
    expect(popover.open()).toBe(true);
    setBlockingModalActive(true);
    await settle();
    expect(popover.open()).toBe(false);
  });

  it("As the auth modal, a surface with closeOnBlockingModal false stays open when a blocking modal comes up", async () => {
    // Given
    const popover = renderPopover("dialog", { closeOnBlockingModal: false });
    await openPopover(popover);

    // When
    setBlockingModalActive(true);
    await settle();

    // Then
    expect(popover.open()).toBe(true);
  });

  it("As a user tapping into the product iframe, the window losing focus closes a closeOnBlur popover", async () => {
    // Given
    const popover = renderPopover("popover", { closeOnBlur: true });
    await openPopover(popover);

    // When
    window.dispatchEvent(new Event("blur"));
    await settle();

    // Then
    expect(popover.open()).toBe(false);
  });

  it("As a user, the window losing focus leaves a popover without closeOnBlur open", async () => {
    // Given
    const popover = renderPopover("popover");
    await openPopover(popover);

    // When: the window blurs, which blurs the focused element with no
    // element to receive focus.
    (document.activeElement as HTMLElement).blur();
    window.dispatchEvent(new Event("blur"));
    await settle();

    // Then
    expect(popover.open()).toBe(true);
  });

  it("As a component, onClose hears every close, whatever closed it, and never an open", async () => {
    // Given
    const onClose = vi.fn();
    const popover = renderPopover("popover", { closeOnBlur: true, onClose });
    const closers = [
      () => pointerClick(byId("outside")),
      () => byId("outside").focus(),
      () => press("Escape"),
      () => window.dispatchEvent(new Event("blur")),
      () => setBlockingModalActive(true),
      () => popover.setOpen(false),
      () => popover.toggle(),
      () => popover.onItemChosen(),
    ];

    for (const [i, close] of closers.entries()) {
      // When
      setBlockingModalActive(false);
      await openPopover(popover);
      close();
      await settle();

      // Then
      expect(popover.open()).toBe(false);
      expect(onClose).toHaveBeenCalledTimes(i + 1);
    }
    popover.setOpen(false);
    expect(onClose).toHaveBeenCalledTimes(closers.length);
  });

  it.each<PopoverMode>(["popover", "menu", "dialog"])(
    "As a page, unmounting an open %s removes every listener it added and unlocks scroll",
    async (mode) => {
      // Given
      const onClose = vi.fn();
      const added: [EventTarget, string, unknown][] = [];
      const removed: [EventTarget, string, unknown][] = [];
      for (const target of [document, window]) {
        const add = target.addEventListener.bind(target);
        const remove = target.removeEventListener.bind(target);
        vi.spyOn(target, "addEventListener").mockImplementation(
          (type, listener, opts) => {
            added.push([target, type, listener]);
            add(type, listener, opts);
          },
        );
        vi.spyOn(target, "removeEventListener").mockImplementation(
          (type, listener, opts) => {
            removed.push([target, type, listener]);
            remove(type, listener, opts);
          },
        );
      }
      const popover = renderPopover(mode, { closeOnBlur: true, onClose });
      await openPopover(popover);

      // When
      popover.unmount();
      await settle();

      // Then
      const ours = added.filter(([, type]) =>
        ["pointerdown", "click", "keydown", "focusout", "blur"].includes(type),
      );
      expect(ours.length).toBeGreaterThan(0);
      for (const entry of ours) {
        expect(removed).toContainEqual(entry);
      }
      expect(document.body.style.overflow).toBe("");
      document.body.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true }),
      );
      press("Escape");
      window.dispatchEvent(new Event("blur"));
      setBlockingModalActive(true);
      await settle();
      expect(onClose).not.toHaveBeenCalled();
    },
  );
});

describe("createPopover, popover mode (Radix Popover, non-modal)", () => {
  it("As a keyboard user, Tab is not trapped: it moves on naturally from the last element", async () => {
    // Given
    const popover = renderPopover("popover");
    await openPopover(popover);
    byId("last").focus();

    // When
    const event = press("Tab");

    // Then
    expect(event.defaultPrevented).toBe(false);
  });

  it("As a keyboard user, focus leaving the trigger and the popover closes it and stays where it went", async () => {
    // Given
    const popover = renderPopover("popover");
    await openPopover(popover);

    // When
    byId("outside").focus();
    await settle();

    // Then
    expect(popover.open()).toBe(false);
    expect(document.activeElement).toBe(byId("outside"));
  });

  it("As a keyboard user, focus moving between the trigger and the popover leaves it open", async () => {
    // Given
    const popover = renderPopover("popover");
    await openPopover(popover);

    // When
    byId("trigger").focus();
    byId("last").focus();
    byId("surface").focus();
    await settle();

    // Then
    expect(popover.open()).toBe(true);
  });

  it("As a user, a click inside the popover that briefly blurs to the body leaves it open", async () => {
    // Given
    const popover = renderPopover("popover");
    await openPopover(popover);

    // When: Safari moves focus to the body on a click on a button.
    byId("last").dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true }),
    );
    (document.activeElement as HTMLElement).blur();
    byId("last").click();
    await settle();

    // Then
    expect(popover.open()).toBe(true);
  });

  it("As a user, an outside pointerdown closes the popover without handing focus back, so focus follows my click", async () => {
    // Given
    const popover = renderPopover("popover");
    await openPopover(popover);

    // When
    const { reached } = pointerClick(byId("outside"));
    await settle();

    // Then
    expect(popover.open()).toBe(false);
    expect(reached).toBe(true);
    expect(document.activeElement).toBe(byId("outside"));
  });

  it("As a user, an outside pointerdown on nothing focusable closes the popover and leaves focus on the body", async () => {
    // Given
    const popover = renderPopover("popover");
    await openPopover(popover);

    // When: the browser moves focus to the body.
    document.body.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true }),
    );
    (document.activeElement as HTMLElement).blur();
    await settle();

    // Then
    expect(popover.open()).toBe(false);
    expect(document.activeElement).toBe(document.body);
  });

  it("As a keyboard user, closing the popover from inside it hands focus back to the trigger", async () => {
    // Given
    const popover = renderPopover("popover");
    await openPopover(popover);
    byId("last").focus();

    // When
    popover.setOpen(false);
    await settle();

    // Then
    expect(document.activeElement).toBe(byId("trigger"));
  });
});

describe("createPopover, menu mode (Radix DropdownMenu, modal)", () => {
  async function openWithKey(key: string): Promise<Popover> {
    const popover = renderPopover("menu");
    byId("trigger").focus();
    const event = press(key);
    await settle();
    expect(popover.open()).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    return popover;
  }

  it.each(["Enter", " ", "ArrowDown"])(
    "As a keyboard user, %j on the trigger opens the menu and focuses the first item",
    async (key) => {
      // When
      await openWithKey(key);

      // Then
      expect(document.activeElement).toBe(byId("apple"));
    },
  );

  it("As a keyboard user, Enter on the trigger of an open menu closes it", async () => {
    // Given
    const popover = renderPopover("menu");
    await openPopover(popover);
    byId("trigger").focus();

    // When
    press("Enter");
    await settle();

    // Then
    expect(popover.open()).toBe(false);
  });

  it("As a mouse user, opening the menu with a pointer focuses the menu content", async () => {
    // Given
    const popover = renderPopover("menu");

    // When
    popover.toggle();
    await settle();

    // Then
    expect(document.activeElement).toBe(byId("surface"));
  });

  it("As a keyboard user, ArrowDown and ArrowUp move between the visible items and loop", async () => {
    // Given
    await openWithKey("ArrowDown");

    // When / Then
    press("ArrowDown");
    expect(document.activeElement).toBe(byId("banana"));
    press("ArrowDown");
    press("ArrowDown");
    expect(document.activeElement).toBe(byId("cherry"));
    const event = press("ArrowDown");
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(byId("apple"));
    press("ArrowUp");
    expect(document.activeElement).toBe(byId("cherry"));
  });

  it("As a keyboard user, ArrowDown or ArrowUp on the menu content focuses the first or last item", async () => {
    // Given
    const popover = renderPopover("menu");
    await openPopover(popover);
    expect(document.activeElement).toBe(byId("surface"));

    // When / Then
    press("ArrowDown");
    expect(document.activeElement).toBe(byId("apple"));
    byId("surface").focus();
    press("ArrowUp");
    expect(document.activeElement).toBe(byId("cherry"));
  });

  it("As a keyboard user, Home and End jump to the first and last items", async () => {
    // Given
    await openWithKey("ArrowDown");

    // When / Then
    press("End");
    expect(document.activeElement).toBe(byId("cherry"));
    press("Home");
    expect(document.activeElement).toBe(byId("apple"));
  });

  it("As a keyboard user, typing a letter focuses the next item starting with it, cycling on repeats", async () => {
    // Given
    await openWithKey("ArrowDown");

    // When / Then
    press("c");
    expect(document.activeElement).toBe(byId("cherry"));
    press("A");
    expect(document.activeElement).toBe(byId("apple"));
    press("a");
    expect(document.activeElement).toBe(byId("avocado"));
    press("a");
    expect(document.activeElement).toBe(byId("apple"));
    press("z");
    expect(document.activeElement).toBe(byId("apple"));
  });

  it("As a mouse user, hovering an item focuses it", async () => {
    // Given
    const popover = renderPopover("menu");
    await openPopover(popover);

    // When
    byId("banana").dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" }),
    );

    // Then
    expect(document.activeElement).toBe(byId("banana"));
  });

  it("As a keyboard user, Tab is prevented, so focus stays in the menu", async () => {
    // Given
    const popover = await openWithKey("ArrowDown");

    // When
    const tab = press("Tab");
    const shiftTab = press("Tab", { shiftKey: true });
    await settle();

    // Then
    expect(tab.defaultPrevented).toBe(true);
    expect(shiftTab.defaultPrevented).toBe(true);
    expect(popover.open()).toBe(true);
    expect(document.activeElement).toBe(byId("apple"));
  });

  it("As a user, an outside pointerdown closes the menu and swallows that click, so it does not activate what is underneath", async () => {
    // Given
    const popover = renderPopover("menu");
    await openPopover(popover);
    const documentClicks = vi.fn();
    document.addEventListener("click", documentClicks);

    // When
    const { click, reached } = pointerClick(byId("outside"));
    await settle();

    // Then
    expect(popover.open()).toBe(false);
    expect(reached).toBe(false);
    expect(click.defaultPrevented).toBe(true);
    expect(documentClicks).not.toHaveBeenCalled();

    // When: the next click is a new one.
    byId("outside").click();

    // Then
    expect(documentClicks).toHaveBeenCalledTimes(1);
    document.removeEventListener("click", documentClicks);
  });

  it("As a user, an outside pointerdown whose click never comes does not swallow a later click", async () => {
    // Given: a press outside that turns into a scroll, so no click follows.
    const popover = renderPopover("menu");
    await openPopover(popover);
    byId("outside").dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true }),
    );
    await settle();
    expect(popover.open()).toBe(false);

    // When
    const { reached } = pointerClick(byId("outside"));

    // Then
    expect(reached).toBe(true);
  });

  it("As a keyboard user, choosing an item closes the menu and hands focus back to the trigger", async () => {
    // Given
    const popover = await openWithKey("ArrowDown");
    press("ArrowDown");

    // When
    popover.onItemChosen();
    await settle();

    // Then
    expect(popover.open()).toBe(false);
    expect(document.activeElement).toBe(byId("trigger"));
  });
});

describe("createPopover, dialog mode (Radix Dialog, modal)", () => {
  it("As a keyboard user, Tab and Shift+Tab are trapped inside the dialog", async () => {
    // Given
    const popover = renderPopover("dialog");
    await openPopover(popover);

    // When / Then
    byId("last").focus();
    let event = press("Tab");
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(byId("first"));
    event = press("Tab", { shiftKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(byId("last"));
    byId("first").focus();
    event = press("Tab");
    expect(event.defaultPrevented).toBe(false);
  });

  it("As a user, the page does not scroll while the dialog is open, and scrolls again after", async () => {
    // Given
    document.body.style.overflow = "scroll";
    const popover = renderPopover("dialog");

    // When
    await openPopover(popover);

    // Then
    expect(document.body.style.overflow).toBe("hidden");

    // When
    popover.setOpen(false);
    await settle();

    // Then
    expect(document.body.style.overflow).toBe("scroll");
  });

  it("As a user, a click on the backdrop closes the dialog and focus goes back to the trigger", async () => {
    // Given
    const popover = renderPopover("dialog");
    await openPopover(popover);

    // When: the backdrop is outside the dialog's surface.
    document.body.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true }),
    );
    await settle();

    // Then
    expect(popover.open()).toBe(false);
    expect(document.activeElement).toBe(byId("trigger"));
  });
});
