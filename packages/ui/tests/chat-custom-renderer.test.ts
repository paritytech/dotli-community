import { describe, expect, it, vi } from "vitest";
import type { RendererNode } from "@parity/truapi";
import { renderNode } from "@dotli/ui/chat/custom-renderer";

const noAction = (): void => undefined;

function renderElement(node: RendererNode): HTMLElement {
  const rendered = renderNode(node, noAction);
  if (!(rendered instanceof HTMLElement)) {
    throw new Error("expected an element");
  }
  return rendered;
}

describe("chat custom renderer", () => {
  it("As a product, every layout node maps onto host DOM", () => {
    const tree: RendererNode = {
      tag: "Column",
      value: {
        modifiers: [
          { tag: "Padding", value: { top: 12, end: 8 } },
          {
            tag: "Background",
            value: {
              color: "BgSurfaceContainer",
              shape: { tag: "Rounded", value: 10 },
            },
          },
        ],
        props: {
          horizontalAlignment: "Center",
          verticalArrangement: "SpaceBetween",
        },
        children: [
          {
            tag: "Text",
            value: {
              modifiers: [],
              props: { style: "HeadlineLarge", color: "FgError" },
              children: [{ tag: "String", value: { text: "Poll results" } }],
            },
          },
          {
            tag: "Row",
            value: {
              modifiers: [{ tag: "FillWidth", value: true }],
              props: {
                verticalAlignment: "Bottom",
                horizontalArrangement: "End",
              },
              children: [
                { tag: "Spacer", value: { modifiers: [] } },
                { tag: "Nil" },
              ],
            },
          },
          {
            tag: "Box",
            value: {
              modifiers: [
                { tag: "MinHeight", value: 40 },
                {
                  tag: "Border",
                  value: {
                    width: 1,
                    color: "FgTertiary",
                    shape: { tag: "Circle" },
                  },
                },
              ],
              props: { contentAlignment: "BottomEnd" },
              children: [],
            },
          },
        ],
      },
    };

    const column = renderElement(tree);
    expect(column.className).toBe("chat-custom-column");
    expect(column.style.padding).toBe("12px 8px");
    expect(column.style.backgroundColor).toBe(
      "var(--chat-bg-surface-container)",
    );
    expect(column.style.borderRadius).toBe("10px");
    expect(column.style.alignItems).toBe("center");
    expect(column.style.justifyContent).toBe("space-between");

    const [text, row, box] = Array.from(column.children) as HTMLElement[];
    expect(text.className).toBe("chat-custom-text");
    expect(text.textContent).toBe("Poll results");
    expect(text.style.fontSize).toBe("32px");
    expect(text.style.fontWeight).toBe("700");
    expect(text.style.color).toBe("var(--chat-fg-error)");

    expect(row.className).toBe("chat-custom-row");
    expect(row.style.width).toBe("100%");
    expect(row.style.alignItems).toBe("flex-end");
    expect(row.style.justifyContent).toBe("flex-end");
    // Spacer renders; Nil renders nothing.
    expect(row.children).toHaveLength(1);
    expect(row.children[0].className).toBe("chat-custom-spacer");

    expect(box.className).toBe("chat-custom-box");
    expect(box.style.minHeight).toBe("40px");
    expect(box.style.borderStyle).toBe("solid");
    expect(box.style.borderColor).toBe("var(--chat-fg-tertiary)");
    expect(box.style.borderRadius).toBe("50%");
    expect(box.style.alignItems).toBe("end");
    expect(box.style.justifyItems).toBe("end");
  });

  it("As a product, four-sided dimensions and sizing modifiers apply", () => {
    const box = renderElement({
      tag: "Box",
      value: {
        modifiers: [
          { tag: "Margin", value: { top: 1, end: 2, bottom: 3, start: 4 } },
          { tag: "Width", value: 120 },
          { tag: "Height", value: 60 },
          { tag: "MinWidth", value: 80 },
        ],
        props: {},
        children: [],
      },
    });
    expect(box.style.margin).toBe("1px 2px 3px 4px");
    expect(box.style.width).toBe("120px");
    expect(box.style.height).toBe("60px");
    expect(box.style.minWidth).toBe("80px");
  });

  it("As a user, tapping a button reports its click action", () => {
    const onAction = vi.fn();
    const rendered = renderNode(
      {
        tag: "Button",
        value: {
          modifiers: [],
          props: {
            text: "Vote",
            variant: "Primary",
            enabled: true,
            loading: undefined,
            clickAction: "vote:1",
          },
          children: [],
        },
      },
      onAction,
    ) as HTMLButtonElement;
    expect(rendered.textContent).toBe("Vote");
    expect(rendered.className).toContain("chat-custom-btn-primary");
    expect(rendered.disabled).toBe(false);
    rendered.click();
    expect(onAction).toHaveBeenCalledWith("vote:1");
  });

  it("As a user, disabled and loading buttons cannot fire actions", () => {
    const onAction = vi.fn();
    const disabled = renderNode(
      {
        tag: "Button",
        value: {
          modifiers: [],
          props: {
            text: "Wait",
            variant: "Secondary",
            enabled: false,
            loading: true,
            clickAction: "noop",
          },
          children: [],
        },
      },
      onAction,
    ) as HTMLButtonElement;
    expect(disabled.disabled).toBe(true);
    expect(disabled.classList.contains("chat-custom-btn-loading")).toBe(true);
    disabled.click();
    expect(onAction).not.toHaveBeenCalled();
  });

  it("As a user, editing a text field reports the typed value", () => {
    const onAction = vi.fn();
    const field = renderNode(
      {
        tag: "TextField",
        value: {
          modifiers: [],
          props: {
            text: "start",
            placeholder: "Your name",
            label: "Name",
            enabled: true,
            valueChangeAction: "name-changed",
          },
        },
      },
      onAction,
    ) as HTMLElement;
    expect(field.querySelector("label")?.textContent).toBe("Name");
    const input = field.querySelector("input");
    if (input === null) {
      throw new Error("expected an input");
    }
    expect(input.value).toBe("start");
    expect(input.placeholder).toBe("Your name");
    input.value = "Alice";
    input.dispatchEvent(new Event("input"));
    expect(onAction).toHaveBeenCalledWith(
      "name-changed",
      new TextEncoder().encode("Alice"),
    );
  });

  it("As a product, text can never inject markup", () => {
    const text = renderElement({
      tag: "Text",
      value: {
        modifiers: [],
        props: {},
        children: [
          { tag: "String", value: { text: "<img src=x onerror=alert(1)>" } },
        ],
      },
    });
    expect(text.querySelector("img")).toBeNull();
    expect(text.textContent).toBe("<img src=x onerror=alert(1)>");
  });

  it("applies square corners, opacity and compositing to the rendered body", () => {
    const box = renderElement({
      tag: "Box",
      value: {
        modifiers: [
          {
            tag: "Background",
            value: {
              color: "BgSurfaceMain",
              shape: { tag: "Rounded", value: 12 },
            },
          },
          {
            tag: "Border",
            value: { width: 1, color: "FgPrimary", shape: { tag: "Square" } },
          },
          { tag: "Opacity", value: 128 },
          { tag: "BlendingMode", value: "ColorDodge" },
        ],
        props: {},
        children: [],
      },
    });
    expect(box.style.borderRadius).toBe("0px");
    expect(Number(box.style.opacity)).toBeCloseTo(128 / 255);
    expect(box.style.mixBlendMode).toBe("color-dodge");
  });

  it("renders button children rather than silently discarding them", () => {
    const button = renderElement({
      tag: "Button",
      value: {
        modifiers: [],
        props: { text: "Vote" },
        children: [{ tag: "String", value: { text: " (3 remaining)" } }],
      },
    });
    expect(button.textContent).toBe("Vote (3 remaining)");
  });

  it("loads images as host-owned object URLs and releases them with the tree", async () => {
    const controller = new AbortController();
    const createObjectURL = vi.fn(() => "blob:renderer-image");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal(
      "URL",
      class extends URL {
        static createObjectURL = createObjectURL;
        static revokeObjectURL = revokeObjectURL;
      },
    );
    try {
      const image = renderNode(
        {
          tag: "Image",
          value: {
            modifiers: [{ tag: "Width", value: 64 }],
            props: {
              source: { tag: "Archive", value: "icon.png" },
              fit: "ScaleDown",
            },
          },
        },
        noAction,
        {
          signal: controller.signal,
          loadImage: async () =>
            new Blob(["image bytes"], { type: "image/png" }),
          onError: (error) => {
            throw error;
          },
        },
      ) as HTMLImageElement;
      await vi.waitFor(() =>
        expect(image.getAttribute("src")).toBe("blob:renderer-image"),
      );
      expect(image.style.objectFit).toBe("scale-down");
      expect(image.style.width).toBe("64px");
      controller.abort();
      expect(image.hasAttribute("src")).toBe(false);
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:renderer-image");
    } finally {
      controller.abort();
      vi.unstubAllGlobals();
    }
  });

  it("does not create image resources after the tree is disposed", async () => {
    const controller = new AbortController();
    let resolveImage!: (blob: Blob) => void;
    const imageBytes = new Promise<Blob>((resolve) => {
      resolveImage = resolve;
    });
    const onError = vi.fn();
    const image = renderNode(
      {
        tag: "Image",
        value: {
          modifiers: [],
          props: {
            source: { tag: "Bulletin", value: "unused-cid" },
            fit: "Contain",
          },
        },
      },
      noAction,
      {
        signal: controller.signal,
        loadImage: () => imageBytes,
        onError,
      },
    ) as HTMLImageElement;
    controller.abort();
    resolveImage(new Blob(["late bytes"]));
    await imageBytes;
    await Promise.resolve();
    expect(image.hasAttribute("src")).toBe(false);
    expect(onError).not.toHaveBeenCalled();
  });

  it("tints effect children without intercepting their actions and cancels animation", () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const animate = vi.fn(() => ({ cancel }));
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const originalAnimate = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "animate",
    );
    Object.defineProperty(Element.prototype, "animate", {
      configurable: true,
      value: animate,
    });
    try {
      const onAction = vi.fn();
      const effect = renderNode(
        {
          tag: "Effect",
          value: {
            props: { effect: "Rainbow" },
            children: [
              {
                tag: "Button",
                value: {
                  modifiers: [],
                  props: { text: "Tinted button", clickAction: "tap" },
                  children: [],
                },
              },
            ],
          },
        },
        onAction,
        {
          signal: controller.signal,
          loadImage: async () => {
            throw new Error("No images in this tree");
          },
          onError: (error) => {
            throw error;
          },
        },
      ) as HTMLElement;
      expect(effect.textContent).toBe("Tinted button");
      expect(
        effect.querySelector<HTMLElement>("[aria-hidden]")?.style.pointerEvents,
      ).toBe("none");
      effect.querySelector("button")?.click();
      expect(onAction).toHaveBeenCalledWith("tap");
      controller.abort();
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      controller.abort();
      if (originalAnimate === undefined) {
        Reflect.deleteProperty(Element.prototype, "animate");
      } else {
        Object.defineProperty(Element.prototype, "animate", originalAnimate);
      }
      vi.unstubAllGlobals();
    }
  });
});
