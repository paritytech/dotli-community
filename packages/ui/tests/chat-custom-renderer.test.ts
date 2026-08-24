import { describe, expect, it, vi } from "vitest";
import type { CustomRendererNode } from "@parity/truapi";
import { renderCustomNode } from "@dotli/ui/chat/custom-renderer";

const noAction = (): void => undefined;

function renderElement(node: CustomRendererNode): HTMLElement {
  const rendered = renderCustomNode(node, noAction);
  if (!(rendered instanceof HTMLElement)) {
    throw new Error("expected an element");
  }
  return rendered;
}

describe("chat custom renderer", () => {
  it("As a product, every layout node maps onto host DOM", () => {
    const tree: CustomRendererNode = {
      tag: "Column",
      value: {
        modifiers: [
          { tag: "Padding", value: { top: 12, end: 8 } },
          {
            tag: "Background",
            value: {
              color: "BgSurfaceContainer",
              shape: { tag: "Rounded", value: { radius: 10 } },
            },
          },
        ],
        props: { horizontalAlignment: "Center", verticalArrangement: "SpaceBetween" },
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
              modifiers: [{ tag: "FillWidth", value: { enabled: true } }],
              props: { verticalAlignment: "Bottom", horizontalArrangement: "End" },
              children: [
                { tag: "Spacer", value: { modifiers: [], children: [] } },
                { tag: "Nil" },
              ],
            },
          },
          {
            tag: "Box",
            value: {
              modifiers: [
                { tag: "MinHeight", value: { height: 40 } },
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
    expect(column.style.backgroundColor).toBe("var(--chat-bg-surface-container)");
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
          { tag: "Width", value: { width: 120 } },
          { tag: "Height", value: { height: 60 } },
          { tag: "MinWidth", value: { width: 80 } },
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
    const rendered = renderCustomNode(
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
    const disabled = renderCustomNode(
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
    const field = renderCustomNode(
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
          children: [],
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
});
