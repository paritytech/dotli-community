// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPopover,
  type PopoverOptions,
} from "@dotli/ui/components/shell/popover";
import { setBlockingModalActive } from "@dotli/ui/state/topbar";
import { renderComponent, resetStores, settle } from "../../helpers/solid";

type Popover = ReturnType<typeof createPopover>;

/**
 * A trigger, a surface with two buttons, and a button outside both. The
 * trigger has no click handler of its own, so a click on it tests only what
 * the popover does with it.
 */
function renderPopover(
  options: Omit<PopoverOptions, "trigger" | "surface"> = {},
): Popover & { unmount: () => void } {
  let popover: Popover | undefined;
  function Harness() {
    let trigger: HTMLButtonElement | undefined;
    let surface: HTMLDivElement | undefined;
    popover = createPopover({
      ...options,
      trigger: () => trigger,
      surface: () => surface,
    });
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
          <button id="first" type="button">
            First
          </button>
          <button id="last" type="button">
            Last
          </button>
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

describe("createPopover", () => {
  afterEach(() => {
    resetStores();
    vi.restoreAllMocks();
  });

  it("As a user, the trigger toggles the popover open and closed", async () => {
    // Given
    const popover = renderPopover();
    expect(popover.open()).toBe(false);

    // When / Then
    popover.toggle();
    await settle();
    expect(popover.open()).toBe(true);
    popover.toggle();
    await settle();
    expect(popover.open()).toBe(false);
  });

  it("As a user, a click outside the trigger and the popover closes it", async () => {
    // Given
    const popover = renderPopover();
    await openPopover(popover);

    // When
    byId("outside").click();
    await settle();

    // Then
    expect(popover.open()).toBe(false);
  });

  it("As a user, a click inside the popover or on the trigger leaves it open", async () => {
    // Given
    const popover = renderPopover();
    await openPopover(popover);

    // When
    byId("first").click();
    byId("trigger-icon").click();
    await settle();

    // Then
    expect(popover.open()).toBe(true);
  });

  it("As a keyboard user, Escape closes the popover and hands focus back to the trigger when focus was inside it", async () => {
    // Given
    const popover = renderPopover();
    await openPopover(popover);
    byId("first").focus();

    // When
    press("Escape");
    await settle();

    // Then
    expect(popover.open()).toBe(false);
    expect(document.activeElement).toBe(byId("trigger"));
  });

  it("As a Safari user, whose focus stays on the body after a click, Escape hands focus back to the trigger", async () => {
    // Given
    const popover = renderPopover();
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

  it("As a keyboard user, Escape leaves my focus alone when it is elsewhere on the page", async () => {
    // Given
    const popover = renderPopover();
    await openPopover(popover);
    byId("outside").focus();

    // When
    press("Escape");
    await settle();

    // Then
    expect(popover.open()).toBe(false);
    expect(document.activeElement).toBe(byId("outside"));
  });

  it("As a user tapping into the product iframe, the window losing focus closes a closeOnBlur popover", async () => {
    // Given
    const popover = renderPopover({ closeOnBlur: true });
    await openPopover(popover);

    // When
    window.dispatchEvent(new Event("blur"));
    await settle();

    // Then
    expect(popover.open()).toBe(false);
  });

  it("As a user, the window losing focus leaves a popover without closeOnBlur open", async () => {
    // Given
    const popover = renderPopover();
    await openPopover(popover);

    // When
    window.dispatchEvent(new Event("blur"));
    await settle();

    // Then
    expect(popover.open()).toBe(true);
  });

  it("As a user, a blocking modal coming up closes the popover", async () => {
    // Given
    const popover = renderPopover();
    await openPopover(popover);

    // When
    setBlockingModalActive(true);
    await settle();

    // Then
    expect(popover.open()).toBe(false);
  });

  it("As a user, a popover opened while a blocking modal is already up stays open until another one comes up", async () => {
    // Given
    setBlockingModalActive(true);
    const popover = renderPopover();

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

  it("As a component, onClose hears every close, whatever closed it, and never an open", async () => {
    // Given
    const onClose = vi.fn();
    const popover = renderPopover({ closeOnBlur: true, onClose });
    const closers = [
      () => byId("outside").click(),
      () => press("Escape"),
      () => window.dispatchEvent(new Event("blur")),
      () => setBlockingModalActive(true),
      () => popover.setOpen(false),
      () => popover.toggle(),
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

  it("As a keyboard user, a focus-trapping popover takes focus on open and keeps Tab and Shift+Tab inside it", async () => {
    // Given
    const popover = renderPopover({ trapFocus: true });
    byId("trigger").focus();

    // When
    await openPopover(popover);

    // Then
    expect(document.activeElement).toBe(byId("surface"));
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
    byId("outside").focus();
    event = press("Tab");
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(byId("first"));
  });

  it("As a keyboard user, closing a focus-trapping popover hands focus back to the trigger unless I moved it elsewhere", async () => {
    // Given
    const popover = renderPopover({ trapFocus: true });
    await openPopover(popover);
    byId("first").focus();

    // When
    popover.setOpen(false);
    await settle();

    // Then
    expect(document.activeElement).toBe(byId("trigger"));

    // When
    await openPopover(popover);
    byId("outside").focus();
    byId("outside").click();
    await settle();

    // Then
    expect(popover.open()).toBe(false);
    expect(document.activeElement).toBe(byId("outside"));
  });

  it("As a keyboard user, Escape on a focus-trapping popover closes it and hands focus back to the trigger", async () => {
    // Given
    const popover = renderPopover({ trapFocus: true });
    await openPopover(popover);
    byId("last").focus();

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
    const popover = renderPopover({
      trapFocus: true,
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

  it("As a page, unmounting an open popover removes every listener it added", async () => {
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
    const popover = renderPopover({
      trapFocus: true,
      closeOnBlur: true,
      onClose,
    });
    await openPopover(popover);

    // When
    popover.unmount();
    await settle();

    // Then
    const ours = added.filter(([, type]) =>
      ["click", "keydown", "blur"].includes(type),
    );
    expect(ours.length).toBeGreaterThan(0);
    for (const entry of ours) {
      expect(removed).toContainEqual(entry);
    }
    document.body.click();
    press("Escape");
    window.dispatchEvent(new Event("blur"));
    setBlockingModalActive(true);
    await settle();
    expect(onClose).not.toHaveBeenCalled();
  });
});
