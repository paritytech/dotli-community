// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installPolkaVmViewInsetsRelay,
  keyboardInsetsForFrame,
  POLKAVM_VIEW_INSETS,
  POLKAVM_VIEW_INSETS_REQUEST,
} from "@dotli/ui/polkavm-view-insets";

const frame = {
  left: 0,
  top: 56,
  right: 390,
  bottom: 844,
  width: 390,
  height: 788,
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("PolkaVM visual viewport insets", () => {
  it("reports no residual inset when the product is fully visible", () => {
    expect(
      keyboardInsetsForFrame(
        frame,
        {
          offsetLeft: 0,
          offsetTop: 0,
          width: 390,
          height: 844,
          scale: 1,
        },
        3,
      ),
    ).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
  });

  it("reports keyboard overlap in physical pixels", () => {
    expect(
      keyboardInsetsForFrame(
        frame,
        {
          offsetLeft: 0,
          offsetTop: 0,
          width: 390,
          height: 600,
          scale: 1,
        },
        3,
      ),
    ).toEqual({ left: 0, top: 0, right: 0, bottom: 732 });
  });

  it("does not double count a layout viewport already resized above the keyboard", () => {
    expect(
      keyboardInsetsForFrame(
        { ...frame, bottom: 600, height: 544 },
        {
          offsetLeft: 0,
          offsetTop: 0,
          width: 390,
          height: 600,
          scale: 1,
        },
        3,
      ),
    ).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
  });

  it("maps every residual visual viewport edge to the product frame", () => {
    expect(
      keyboardInsetsForFrame(
        { left: 0, top: 0, right: 400, bottom: 800, width: 400, height: 800 },
        {
          offsetLeft: 10,
          offsetTop: 40,
          width: 380,
          height: 600,
          scale: 1,
        },
        2,
      ),
    ).toEqual({ left: 20, top: 80, right: 20, bottom: 320 });
  });

  it("does not reinterpret pinch zoom as application occlusion", () => {
    expect(
      keyboardInsetsForFrame(
        frame,
        {
          offsetLeft: 40,
          offsetTop: 100,
          width: 195,
          height: 422,
          scale: 2,
        },
        3,
      ),
    ).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
  });

  it("clamps values to the guest input record limit", () => {
    expect(
      keyboardInsetsForFrame(
        {
          left: 0,
          top: 0,
          right: 400,
          bottom: 20_000,
          width: 400,
          height: 20_000,
        },
        {
          offsetLeft: 0,
          offsetTop: 0,
          width: 400,
          height: 0,
          scale: 1,
        },
        4,
      ).bottom,
    ).toBe(65_535);
  });
});

describe("PolkaVM visual viewport relay", () => {
  it("sends measured occlusion only to the matching product origin", () => {
    const visualViewport = Object.assign(new EventTarget(), {
      offsetLeft: 0,
      offsetTop: 0,
      width: 400,
      height: 600,
      scale: 1,
    }) as unknown as VisualViewport;
    vi.stubGlobal("visualViewport", visualViewport);
    vi.stubGlobal("devicePixelRatio", 2);
    vi.stubGlobal("ResizeObserver", undefined);

    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    vi.spyOn(iframe, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      right: 400,
      bottom: 800,
      width: 400,
      height: 800,
    } as DOMRect);
    const target = iframe.contentWindow;
    if (target === null) {
      throw new Error("test iframe has no content window");
    }
    const postMessage = vi
      .spyOn(target, "postMessage")
      .mockImplementation(() => {});
    const dispose = installPolkaVmViewInsetsRelay(
      iframe,
      "https://product.test",
    );

    iframe.dispatchEvent(new Event("load"));
    expect(postMessage).toHaveBeenLastCalledWith(
      {
        type: POLKAVM_VIEW_INSETS,
        keyboard: { left: 0, top: 0, right: 0, bottom: 400 },
      },
      "https://product.test",
    );

    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: POLKAVM_VIEW_INSETS_REQUEST },
        origin: "https://attacker.test",
        source: target,
      }),
    );
    expect(postMessage).toHaveBeenCalledTimes(1);

    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: POLKAVM_VIEW_INSETS_REQUEST },
        origin: "https://product.test",
        source: target,
      }),
    );
    expect(postMessage).toHaveBeenCalledTimes(2);

    dispose();
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: POLKAVM_VIEW_INSETS_REQUEST },
        origin: "https://product.test",
        source: target,
      }),
    );
    expect(postMessage).toHaveBeenCalledTimes(2);
  });
});
