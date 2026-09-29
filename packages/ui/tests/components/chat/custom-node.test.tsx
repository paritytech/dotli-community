import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RendererNode } from "@parity/truapi";
import {
  CustomNode,
  type CustomActionHandler,
} from "../../../src/components/chat/CustomNode.js";
import { renderComponent, settle } from "../../helpers/solid.js";
import { nth } from "../../helpers/nth.js";

const noAction = (): void => undefined;

function renderCustomNode(
  node: RendererNode,
  onAction: CustomActionHandler,
): Element | null {
  const { container } = renderComponent(() => (
    <CustomNode node={node} onAction={onAction} />
  ));
  return container.firstElementChild;
}

function renderElement(node: RendererNode): HTMLElement {
  const rendered = renderCustomNode(node, noAction);
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

    const children = Array.from(column.children) as HTMLElement[];
    const text = nth(children, 0);
    const row = nth(children, 1);
    const box = nth(children, 2);
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
    expect(row.children[0]?.className).toBe("chat-custom-spacer");

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
    const rendered = renderCustomNode(
      {
        tag: "Button",
        value: {
          modifiers: [],
          props: {
            text: "Vote",
            variant: "Primary",
            enabled: true,
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
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onAction).toHaveBeenCalledWith(
      "name-changed",
      new TextEncoder().encode("Alice"),
    );
  });

  it("As a product, opacity, blending and the new node kinds map onto host DOM", () => {
    const effect = renderElement({
      tag: "Effect",
      value: {
        props: { effect: "Rainbow" },
        children: [
          {
            tag: "Box",
            value: {
              modifiers: [
                { tag: "Opacity", value: 51 },
                { tag: "BlendingMode", value: "Multiply" },
                {
                  tag: "Background",
                  value: { color: "BgSurfaceMain", shape: { tag: "Square" } },
                },
              ],
              props: {},
              children: [
                {
                  tag: "Image",
                  value: {
                    modifiers: [
                      { tag: "Width", value: 24 },
                      { tag: "Height", value: 24 },
                    ],
                    props: {
                      source: { tag: "Archive", value: "icon.png" },
                      fit: "Cover",
                    },
                  },
                },
              ],
            },
          },
        ],
      },
    });
    expect(effect.className).toBe(
      "chat-custom-effect chat-custom-effect-rainbow",
    );
    const box = effect.children[0] as HTMLElement;
    expect(box.style.opacity).toBe("0.2");
    expect(box.style.mixBlendMode).toBe("multiply");
    expect(box.style.borderRadius).toBe("0px");
    // Image bytes are not fetched yet: the node is empty space, never an URL.
    const image = box.children[0] as HTMLElement;
    expect(image.className).toBe("chat-custom-image");
    expect(image.style.width).toBe("24px");
    expect(image.style.height).toBe("24px");
    expect(image.childNodes).toHaveLength(0);
    expect(image.querySelector("img")).toBeNull();
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

describe("chat custom renderer, updates", () => {
  function field(text: string, label = "Name"): RendererNode {
    return {
      tag: "TextField",
      value: {
        modifiers: [],
        props: {
          text,
          label,
          enabled: true,
          valueChangeAction: "name-changed",
        },
      },
    };
  }

  function form(heading: string, fieldNode: RendererNode): RendererNode {
    return {
      tag: "Column",
      value: {
        modifiers: [{ tag: "Padding", value: { top: 4, end: 4 } }],
        props: {},
        children: [
          {
            tag: "Text",
            value: {
              modifiers: [],
              props: {},
              children: [{ tag: "String", value: { text: heading } }],
            },
          },
          fieldNode,
        ],
      },
    };
  }

  function renderLive(initial: RendererNode): {
    container: HTMLElement;
    update: (next: RendererNode) => Promise<void>;
  } {
    const [node, setNode] = createSignal(initial);
    const { container } = renderComponent(() => (
      <CustomNode node={node()} onAction={noAction} />
    ));
    return {
      container,
      update: async (next) => {
        setNode(next);
        await settle();
      },
    };
  }

  it("As a user typing in a text field, a new tree from the product keeps my focus, caret and text", async () => {
    // Given: I am typing in the field of a live message.
    const { container, update } = renderLive(form("Sign up", field("")));
    const input = container.querySelector("input");
    if (input === null) {
      throw new Error("expected an input");
    }
    input.focus();
    input.value = "Ali";
    input.setSelectionRange(2, 2);

    // When: the product sends a new tree that changes the heading only.
    await update(form("Sign up (2 left)", field("")));

    // Then: the same field is still there, focused, with my text and caret.
    expect(container.querySelector("input")).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("Ali");
    expect(input.selectionStart).toBe(2);
    expect(container.textContent).toContain("Sign up (2 left)");
  });

  it("As a product, changing the text I send for a field replaces its value", async () => {
    // Given
    const { container, update } = renderLive(form("Sign up", field("")));
    const input = container.querySelector("input");

    // When
    await update(form("Sign up", field("Bob")));

    // Then
    expect(container.querySelector("input")).toBe(input);
    expect(input?.value).toBe("Bob");
  });

  it("As a product, a modifier I drop from the next tree is removed from the element", async () => {
    // Given
    const { container, update } = renderLive(form("Sign up", field("")));
    const column = container.firstElementChild as HTMLElement;
    expect(column.style.padding).toBe("4px");

    // When
    await update({
      tag: "Column",
      value: { modifiers: [], props: {}, children: [] },
    });

    // Then: the same element, without the padding or the old children.
    expect(container.firstElementChild).toBe(column);
    expect(column.style.padding).toBe("");
    expect(column.children).toHaveLength(0);
  });

  it("As a product, a node that changes kind is replaced", async () => {
    // Given
    const { container, update } = renderLive(form("Sign up", field("")));

    // When: the field becomes a button.
    await update(
      form("Sign up", {
        tag: "Button",
        value: {
          modifiers: [],
          props: { text: "Done", clickAction: "done" },
          children: [],
        },
      }),
    );

    // Then
    expect(container.querySelector("input")).toBeNull();
    expect(container.querySelector("button")?.textContent).toBe("Done");
  });

  function labelled(label: string, action: string): RendererNode {
    return {
      tag: "TextField",
      value: {
        modifiers: [],
        props: { text: "", label, valueChangeAction: action },
      },
    };
  }

  function fields(...nodes: RendererNode[]): RendererNode {
    return {
      tag: "Column",
      value: { modifiers: [], props: {}, children: nodes },
    };
  }

  it("As a user typing in a field, a field the product inserts above it does not take my text or focus", async () => {
    // Given: I am typing in Email.
    const typed = vi.fn();
    const [node, setNode] = createSignal(fields(labelled("Email", "email")));
    const { container } = renderComponent(() => (
      <CustomNode node={node()} onAction={typed} />
    ));
    const email = container.querySelector("input");
    if (email === null) {
      throw new Error("expected an input");
    }
    email.focus();
    email.value = "bob@";

    // When: the product inserts Name above Email.
    setNode(fields(labelled("Name", "name"), labelled("Email", "email")));
    await settle();

    // Then: the Name field is empty, and nothing I typed reports as a name.
    const name = nth(container.querySelectorAll("input"), 0);
    expect(name.closest(".chat-custom-field")?.textContent).toBe("Name");
    expect(name.value).toBe("");
    expect(document.activeElement).not.toBe(name);
    name.value = "x";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    expect(typed).toHaveBeenCalledWith("name", new TextEncoder().encode("x"));
    expect(typed).not.toHaveBeenCalledWith(
      "name",
      new TextEncoder().encode("bob@x"),
    );
  });

  it("As a user, a field the product removes above another does not leave its text in that one", async () => {
    // Given: I typed in Name, above Email.
    const [node, setNode] = createSignal(
      fields(labelled("Name", "name"), labelled("Email", "email")),
    );
    const { container } = renderComponent(() => (
      <CustomNode node={node()} onAction={noAction} />
    ));
    const name = nth(container.querySelectorAll("input"), 0);
    name.value = "Alice";

    // When: the product removes Name.
    setNode(fields(labelled("Email", "email")));
    await settle();

    // Then: Email does not show Name's text.
    const inputs = Array.from(container.querySelectorAll("input"));
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.closest(".chat-custom-field")?.textContent).toBe("Email");
    expect(inputs[0]?.value).toBe("");
  });

  it("As a product, a button I update keeps its element and reports its current action", async () => {
    // Given
    const onAction = vi.fn();
    const buttonNode = (
      loading: boolean,
      clickAction: string,
    ): RendererNode => ({
      tag: "Button",
      value: {
        modifiers: [],
        props: { text: "Vote", loading, clickAction },
        children: [],
      },
    });
    const [node, setNode] = createSignal(buttonNode(true, "vote:1"));
    const { container } = renderComponent(() => (
      <CustomNode node={node()} onAction={onAction} />
    ));
    const button = container.querySelector("button");
    expect(button?.disabled).toBe(true);
    expect(button?.classList.contains("chat-custom-btn-loading")).toBe(true);

    // When
    setNode(buttonNode(false, "vote:2"));
    await settle();
    button?.click();

    // Then
    expect(container.querySelector("button")).toBe(button);
    expect(button?.disabled).toBe(false);
    expect(button?.classList.contains("chat-custom-btn-loading")).toBe(false);
    expect(onAction).toHaveBeenCalledWith("vote:2");
  });

  it("As a product, a Nil tree renders nothing", () => {
    // When
    const { container } = renderComponent(() => (
      <CustomNode node={{ tag: "Nil" }} onAction={noAction} />
    ));

    // Then
    expect(container.childNodes).toHaveLength(0);
  });
});

describe("chat custom renderer, a text field the product echoes", () => {
  // The product's round trip (worker, product, render stream) lands its
  // echo of a keystroke after later keystrokes.
  function echo(text: string): RendererNode {
    return {
      tag: "TextField",
      value: {
        modifiers: [],
        props: { text, label: "Name", valueChangeAction: "name-changed" },
      },
    };
  }

  function renderEchoed(): {
    input: HTMLInputElement;
    send: (text: string) => Promise<void>;
    type: (...values: string[]) => void;
  } {
    const [node, setNode] = createSignal(echo(""));
    const { container } = renderComponent(() => (
      <CustomNode node={node()} onAction={noAction} />
    ));
    const input = container.querySelector("input");
    if (input === null) {
      throw new Error("expected an input");
    }
    return {
      input,
      send: async (text) => {
        setNode(echo(text));
        await settle();
      },
      type: (...values) => {
        for (const value of values) {
          input.value = value;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          vi.advanceTimersByTime(100);
        }
      },
    };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("As a user typing, a late echo of an earlier keystroke does not replace my text", async () => {
    // Given
    vi.useFakeTimers();
    const { input, send, type } = renderEchoed();
    input.focus();
    type("a", "ab", "abc");

    // When: the echo of "a" arrives.
    await send("a");

    // Then
    expect(input.value).toBe("abc");

    // When: I keep typing, and the later echoes arrive in between.
    await send("ab");
    type("abcd");
    await send("abc");

    // Then
    expect(input.value).toBe("abcd");
  });

  it("As a user who stopped typing, the product's latest text applies only when it differs from mine", async () => {
    // Given: echoes of my own text, held while I typed.
    vi.useFakeTimers();
    const { input, send, type } = renderEchoed();
    input.focus();
    type("a", "ab", "abc");
    input.setSelectionRange(1, 1);
    await send("a");
    await send("abc");

    // When: typing pauses.
    vi.advanceTimersByTime(1000);
    await settle();

    // Then: my text and caret stay, since the product agrees with them.
    expect(input.value).toBe("abc");
    expect(input.selectionStart).toBe(1);

    // When: the product rewrites the text while I type, then I pause.
    type("abcd");
    await send("ABCD");

    // Then: held while I type.
    expect(input.value).toBe("abcd");

    // When
    vi.advanceTimersByTime(1000);
    await settle();

    // Then
    expect(input.value).toBe("ABCD");
  });

  it("As a user who left the field, the product's text applies at once", async () => {
    // Given: I typed, then moved focus away.
    vi.useFakeTimers();
    const { input, send, type } = renderEchoed();
    input.focus();
    type("a", "ab");
    input.blur();

    // When
    await send("Bob");

    // Then
    expect(input.value).toBe("Bob");
  });

  it("As a screen reader user, a text field's label names its input", () => {
    // When
    const { container } = renderComponent(() => (
      <CustomNode
        node={{
          tag: "Column",
          value: {
            modifiers: [],
            props: {},
            children: [echo(""), echo("")],
          },
        }}
        onAction={noAction}
      />
    ));

    // Then
    const inputs = Array.from(container.querySelectorAll("input"));
    const labels = Array.from(container.querySelectorAll("label"));
    expect(inputs).toHaveLength(2);
    expect(inputs[0]?.id).not.toBe("");
    expect(inputs[0]?.id).not.toBe(inputs[1]?.id);
    expect(labels.map((label) => label.htmlFor)).toEqual(
      inputs.map((input) => input.id),
    );
  });
});
