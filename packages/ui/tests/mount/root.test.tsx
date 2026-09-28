// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSignal, flush, onCleanup } from "solid-js";
import type { JSX } from "@solidjs/web";
import { settle } from "../helpers/solid";

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("@dotli/metrics/sentry", () => sentry);

function container(id: string): HTMLElement {
  const el = document.createElement("div");
  el.id = id;
  document.body.appendChild(el);
  return el;
}

describe("mountRoot", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    sentry.captureException.mockClear();
  });

  it("As a sub-project, a mounted root renders and its disposer empties the container", async () => {
    // Given
    const { mountRoot } = await import("@dotli/ui/mount/root");
    const el = container("a");

    // When
    const dispose = mountRoot("a", el, () => <p class="hello">hi</p>);
    await settle();

    // Then
    expect(el.querySelector(".hello")?.textContent).toBe("hi");
    dispose();
    expect(el.childNodes.length).toBe(0);
  });

  it("As activateHost, disposeAppRoot by name unmounts a root and is a no-op for unknown names", async () => {
    // Given
    const { mountRoot } = await import("@dotli/ui/mount/root");
    const { disposeAppRoot } = await import("@dotli/ui/mount/app-roots");
    const el = container("b");
    mountRoot("b", el, () => <span>b</span>);
    await settle();

    // When
    disposeAppRoot("b");
    disposeAppRoot("never-mounted");

    // Then
    expect(el.childNodes.length).toBe(0);
  });

  it("As a user, a root whose view throws is reported to Sentry and does not break sibling roots", async () => {
    // Given
    const { mountRoot } = await import("@dotli/ui/mount/root");
    const good = container("good");
    const bad = container("bad");
    mountRoot("good", good, () => <span class="ok">ok</span>);

    // When
    mountRoot("bad", bad, () => {
      throw new Error("boom");
    });
    await settle();

    // Then
    expect(good.querySelector(".ok")?.textContent).toBe("ok");
    expect(sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "boom" }),
      { root: "bad" },
    );
    expect(document.body.contains(good)).toBe(true);
  });

  it("As a sub-project, mounting the same name twice disposes the first root", async () => {
    // Given
    const { mountRoot } = await import("@dotli/ui/mount/root");
    const first = container("first");
    const second = container("second");
    mountRoot("dup", first, () => <span>1</span>);

    // When
    mountRoot("dup", second, () => <span>2</span>);
    await settle();

    // Then
    expect(first.childNodes.length).toBe(0);
    expect(second.textContent).toBe("2");
  });

  it("As a sub-project, a disposer runs once and removeContainer takes the container out", async () => {
    // Given
    const { mountRoot } = await import("@dotli/ui/mount/root");
    const { disposeAppRoot } = await import("@dotli/ui/mount/app-roots");
    const el = container("removable");
    const cleanups = vi.fn();
    const dispose = mountRoot(
      "removable",
      el,
      () => {
        onCleanup(cleanups);
        return <span>x</span>;
      },
      { removeContainer: true },
    );
    await settle();

    // When
    dispose();
    dispose();
    disposeAppRoot("removable");

    // Then
    expect(cleanups).toHaveBeenCalledTimes(1);
    expect(el.isConnected).toBe(false);
  });

  it("As a sub-project, a root that breaks after it mounted is reported once, disposed, then hears onBroken once", async () => {
    // Given a view that throws a new error on every change
    const { mountRoot } = await import("@dotli/ui/mount/root");
    const el = container("late");
    const order: string[] = [];
    let breakAgain = (): void => {};
    const view = (): JSX.Element => {
      const [breaks, setBreaks] = createSignal(0, { ownedWrite: true });
      breakAgain = () => setBreaks((n) => n + 1);
      onCleanup(() => order.push("disposed"));
      return [
        <span class="live">live</span>,
        (): null => {
          if (breaks() > 0) {
            throw new Error(`broke ${String(breaks())}`);
          }
          return null;
        },
      ];
    };
    const onError = vi.fn(() => {
      order.push(`onError:${String(el.querySelector(".live") !== null)}`);
    });
    const onBroken = vi.fn(() => order.push("onBroken"));
    mountRoot("late", el, view, { onError, onBroken });
    await settle();
    expect(el.querySelector(".live")).not.toBeNull();

    // When it breaks twice before the microtask, so Solid runs the fallback
    // twice
    breakAgain();
    flush();
    breakAgain();
    flush();

    // Then onError ran inside the boundary, with the nodes still there, and
    // the rest waits a microtask
    expect(order).toEqual(["onError:true"]);
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["onError:true", "disposed", "onBroken"]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onBroken).toHaveBeenCalledTimes(1);
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "broke 1" }),
      { root: "late" },
    );
  });

  it("As a sub-project, a view that throws on its first render is disposed and hears onBroken once", async () => {
    // Given
    const { mountRoot } = await import("@dotli/ui/mount/root");
    const { disposeAppRoot } = await import("@dotli/ui/mount/app-roots");
    const el = container("broken-at-once");
    const onBroken = vi.fn();
    const Broken = (): JSX.Element => {
      throw new Error("render failed");
    };

    // When
    mountRoot("broken-at-once", el, () => <Broken />, {
      onBroken,
      removeContainer: true,
    });
    expect(onBroken).not.toHaveBeenCalled();
    await settle();
    await Promise.resolve();

    // Then
    expect(onBroken).toHaveBeenCalledTimes(1);
    expect(el.isConnected).toBe(false);
    disposeAppRoot("broken-at-once");
    expect(onBroken).toHaveBeenCalledTimes(1);
  });
});
