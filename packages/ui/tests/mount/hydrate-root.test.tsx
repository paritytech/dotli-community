// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// hydrateRoot after a successful hydration: an error the hydrated view raises
// later must reach Sentry, not vanish into the hydration boundary. Runs in
// the `hydration` vitest project (see vitest.config.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSignal, flush } from "solid-js";
import type { JSX } from "@solidjs/web";

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("@dotli/metrics/sentry", () => sentry);

describe("hydrateRoot", () => {
  beforeEach(() => {
    sentry.captureException.mockClear();
    delete (globalThis as { _$HY?: unknown })._$HY;
  });

  afterEach(async () => {
    const { disposeRoot } = await import("@dotli/ui/mount/root");
    disposeRoot("later-error-root");
    document.body.innerHTML = "";
  });

  it("As an operator, an error a hydrated root raises after hydration is reported to Sentry once, and onError hears it", async () => {
    // Given
    const { hydrateRoot } = await import("@dotli/ui/mount/root");
    const container = document.createElement("div");
    document.body.append(container);
    const boom = new Error("broke after hydration");
    let breakView = (): void => undefined;
    // Server-rendered as nothing, so hydration has nothing to claim; the
    // view throws once `broken` flips.
    const view = (): JSX.Element => {
      const [broken, setBroken] = createSignal(false);
      breakView = () => setBroken(true);
      return (() => {
        if (broken()) {
          throw boom;
        }
        return null;
      }) as unknown as JSX.Element;
    };
    const onError = vi.fn();
    const { hydrated } = hydrateRoot("later-error-root", container, view, {
      renderId: "later",
      onError,
    });
    expect(hydrated).toBe(true);
    expect(sentry.captureException).not.toHaveBeenCalled();

    // When
    breakView();
    flush();

    // Then
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.captureException).toHaveBeenCalledWith(boom, {
      root: "later-error-root",
      kind: "render_error",
    });
    expect(onError).toHaveBeenCalledWith(boom);
  });
});
