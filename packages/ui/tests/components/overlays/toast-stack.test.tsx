// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent } from "@solidjs/testing-library";
import { ToastStack } from "@dotli/ui/components/overlays/ToastStack";
import {
  dismissToast,
  pushToast,
  resetToastsForTests,
  toastsStore,
  type ToastInput,
} from "@dotli/ui/state/toasts";
import { renderComponent, settle } from "../../helpers/solid";
import type * as ToastCardModule from "@dotli/ui/components/overlays/ToastCard";
import { query } from "../../support";

/** Reads of each card's layout props (`depth`, `hidden`), across all cards. */
const cardLayoutReads = vi.hoisted(() => ({ count: 0 }));
vi.mock("@dotli/ui/components/overlays/ToastCard", async (importOriginal) => {
  const actual = await importOriginal<typeof ToastCardModule>();
  return {
    ...actual,
    ToastCard: (props: Parameters<typeof actual.ToastCard>[0]) =>
      actual.ToastCard({
        get entry() {
          return props.entry;
        },
        get hidden() {
          cardLayoutReads.count += 1;
          return props.hidden;
        },
        get depth() {
          cardLayoutReads.count += 1;
          return props.depth;
        },
      }),
  };
});

function input(label: string, overrides: Partial<ToastInput> = {}): ToastInput {
  return {
    text: `${label} body`,
    label,
    icon: "<svg></svg>",
    dismissMs: 0,
    ...overrides,
  };
}

function cards(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(".notif-card")];
}

function visibleTitles(): string[] {
  return cards()
    .filter((c) => !c.classList.contains("notif-hidden-card"))
    .map((c) => c.querySelector(".notif-title")?.textContent ?? "");
}

async function mountStack(): Promise<void> {
  renderComponent(() => <ToastStack />);
  await settle();
}

afterEach(() => {
  resetToastsForTests();
  document.body.replaceChildren();
});

describe("toast stack", () => {
  it("As a dotli user, a toast renders today's card markup", async () => {
    // Given
    const onClick = vi.fn();
    pushToast(
      input("Update available", {
        deeplink: "https://dot.li/",
        iconBackground: "#000",
        action: { label: "Reload", onClick },
      }),
    );

    // When
    await mountStack();

    // Then
    const card = cards()[0];
    expect(card.classList.contains("notif-card")).toBe(true);
    expect(card.classList.contains("notif-enter")).toBe(true);
    expect(card.dataset.id).toBe("0");
    expect(
      card.querySelector<HTMLElement>(".notif-icon")?.style.background,
    ).not.toBe("");
    expect(card.querySelector(".notif-title")?.textContent).toBe(
      "Update available",
    );
    const body = card.querySelector<HTMLAnchorElement>("a.notif-body");
    expect(body?.href).toBe("https://dot.li/");
    expect(body?.target).toBe("_blank");
    expect(body?.rel).toBe("noopener");
    expect(
      card.querySelector(".notif-card-close")?.getAttribute("aria-label"),
    ).toBe("Dismiss");
    expect(
      document.querySelector(".notif-cards")?.getAttribute("aria-live"),
    ).toBe("polite");
    expect(document.querySelector(".notif-cards")?.getAttribute("role")).toBe(
      "status",
    );
    expect(
      document.querySelector(".notif-stack")?.classList.contains("single"),
    ).toBe(true);
    expect(
      document.querySelector<HTMLElement>(".notif-close-all")?.style.display,
    ).toBe("none");

    // When
    fireEvent.click(query(card, ".notif-action", HTMLButtonElement));
    fireEvent.animationEnd(card);
    await settle();

    // Then
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(card.classList.contains("notif-enter")).toBe(false);
  });

  it("As a dotli user, only the newest three toasts are visible, with close-all shown", async () => {
    // Given
    for (const label of ["A", "B", "C", "D"]) {
      pushToast(input(label));
    }

    // When
    await mountStack();

    // Then
    expect(visibleTitles()).toEqual(["B", "C", "D"]);
    expect(cards()[0].classList.contains("notif-hidden-card")).toBe(true);
    expect(
      cards()
        .slice(1)
        .map((c) => c.style.getPropertyValue("--i")),
    ).toEqual(["2", "1", "0"]);
    expect(
      document.querySelector<HTMLElement>(".notif-close-all")?.style.display,
    ).toBe("");
    expect(
      document.querySelector(".notif-stack")?.classList.contains("single"),
    ).toBe(false);
  });

  it("As a dotli user, closing a toast plays its exit and removes it when the animation ends", async () => {
    // Given
    pushToast(input("A"));
    await mountStack();
    const card = cards()[0];

    // When
    fireEvent.click(query(card, ".notif-card-close", HTMLButtonElement));
    await settle();

    // Then
    expect(card.classList.contains("notif-leave")).toBe(true);
    expect(document.querySelector(".notif-stack")).not.toBeNull();

    // When
    fireEvent.animationEnd(card);
    await settle();

    // Then
    expect(document.querySelector(".notif-stack")).toBeNull();
    expect(toastsStore.get().items).toEqual([]);
  });

  it("As a dotli user, a toast hidden beyond the visible three disappears at once when dismissed", async () => {
    // Given
    const ids = ["A", "B", "C", "D"].map((label) => pushToast(input(label)));
    await mountStack();

    // When
    dismissToast(ids[0]);
    await settle();

    // Then
    expect(toastsStore.get().items.map((t) => t.label)).toEqual([
      "B",
      "C",
      "D",
    ]);
    expect(cards()).toHaveLength(3);
  });

  it("As a dotli user, clicking the stack expands it, and clicking outside collapses it", async () => {
    // Given
    for (const label of ["A", "B", "C", "D"]) {
      pushToast(input(label));
    }
    await mountStack();

    // When
    fireEvent.click(query(document, ".notif-cards .notif-text"));
    await settle();

    // Then
    expect(toastsStore.get().expanded).toBe(true);
    expect(
      document.querySelector(".notif-stack")?.classList.contains("expanded"),
    ).toBe(true);
    expect(visibleTitles()).toEqual(["A", "B", "C", "D"]);

    // When
    fireEvent.click(document.body);
    await settle();

    // Then
    expect(toastsStore.get().expanded).toBe(false);
    expect(visibleTitles()).toEqual(["B", "C", "D"]);
  });

  it("As a dotli user, clicking a link inside a toast does not expand the stack", async () => {
    // Given
    pushToast(input("A", { deeplink: "https://dot.li/" }));
    pushToast(input("B", { deeplink: "https://dot.li/" }));
    await mountStack();
    const link = query(document, "a.notif-body", HTMLAnchorElement);
    link.addEventListener("click", (event) => {
      event.preventDefault();
    });

    // When
    fireEvent.click(link);
    await settle();

    // Then
    expect(toastsStore.get().expanded).toBe(false);
  });

  it("As a dotli user, dismiss all plays every exit and removes the stack once they finish", async () => {
    // Given
    pushToast(input("A"));
    pushToast(input("B"));
    await mountStack();

    // When
    fireEvent.click(query(document, ".notif-close-all", HTMLButtonElement));
    await settle();

    // Then
    expect(cards().every((c) => c.classList.contains("notif-leave"))).toBe(
      true,
    );
    expect(toastsStore.get().expanded).toBe(false);

    // When
    for (const card of cards()) {
      fireEvent.animationEnd(card);
    }
    await settle();

    // Then
    expect(document.querySelector(".notif-stack")).toBeNull();
  });

  it("As a dotli user, a new toast while the stack is expanded scrolls into view, and nothing else re-scrolls it or re-adds its listeners", async () => {
    // Given: an expanded stack.
    const ids = ["A", "B", "C", "D"].map((label) => pushToast(input(label)));
    await mountStack();
    fireEvent.click(query(document, ".notif-cards .notif-text"));
    await settle();
    expect(toastsStore.get().expanded).toBe(true);
    const list = query(document, ".notif-cards");
    let height = 400;
    Object.defineProperty(list, "scrollHeight", {
      configurable: true,
      get: () => height,
    });
    const scrolls: number[] = [];
    Object.defineProperty(list, "scrollTop", {
      configurable: true,
      get: () => 0,
      set: (value: number) => {
        scrolls.push(value);
      },
    });
    const adds = vi.spyOn(document, "addEventListener");

    // When: a toast is dismissed, and it finishes leaving.
    dismissToast(ids[0]);
    await settle();
    fireEvent.animationEnd(cards()[0]);
    await settle();

    // Then
    expect(visibleTitles()).toEqual(["B", "C", "D"]);
    expect(scrolls).toEqual([]);

    // When: two new toasts.
    height = 500;
    pushToast(input("E"));
    await settle();
    height = 600;
    pushToast(input("F"));
    await settle();

    // Then: each scrolled the list to its end.
    expect(visibleTitles()).toEqual(["B", "C", "D", "E", "F"]);
    expect(scrolls).toEqual([500, 600]);
    expect(adds).not.toHaveBeenCalled();
    adds.mockRestore();
  });

  it("As a dotli user, a new toast while the stack is collapsed does not scroll it", async () => {
    // Given
    pushToast(input("A"));
    pushToast(input("B"));
    await mountStack();
    const list = query(document, ".notif-cards");
    let scrolls = 0;
    Object.defineProperty(list, "scrollTop", {
      configurable: true,
      get: () => 0,
      set: () => {
        scrolls += 1;
      },
    });

    // When
    pushToast(input("C"));
    await settle();

    // Then
    expect(visibleTitles()).toEqual(["A", "B", "C"]);
    expect(scrolls).toBe(0);
  });

  it("As a dotli user, a toast update does a fixed amount of work per card, not work that grows with the stack", async () => {
    // Given: eight cards.
    const ids = ["A", "B", "C", "D", "E", "F", "G", "H"].map((label) =>
      pushToast(input(label)),
    );
    await mountStack();
    const items = toastsStore.get().items;
    const filter = vi.spyOn(Array.prototype, "filter");
    cardLayoutReads.count = 0;

    // When: a visible card starts to leave.
    dismissToast(ids[7]);
    await settle();

    // Then: each card re-read its depth and hidden flag at most once, and
    // the stack's passes over the toasts do not grow with the cards.
    const next = toastsStore.get().items;
    const passes = filter.mock.contexts.filter(
      (c) => c === items || c === next,
    ).length;
    filter.mockRestore();
    expect(cardLayoutReads.count).toBeLessThanOrEqual(2 * items.length);
    expect(passes).toBeLessThanOrEqual(2);
  });

  it("As a dotli user, clicking a stack of one live toast and one leaving does not expand it", async () => {
    // Given
    const first = pushToast(input("A"));
    pushToast(input("B"));
    await mountStack();
    dismissToast(first);
    await settle();
    expect(
      document.querySelector(".notif-stack")?.classList.contains("single"),
    ).toBe(true);

    // When
    fireEvent.click(
      document.querySelectorAll<HTMLElement>(".notif-cards .notif-text")[1],
    );
    await settle();

    // Then
    expect(toastsStore.get().expanded).toBe(false);
  });
});
