// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Vanilla-DOM renderer for product-authored custom message trees.
//
// The tree is a closed vocabulary: the product names layouts and design
// tokens, never markup or styles. Images are fetched by the host from
// typed content sources, never from a product-supplied URL.

import type {
  Arrangement,
  BlendingMode,
  ColorToken,
  ContentAlignment,
  RendererNode,
  Dimensions,
  HorizontalAlignment,
  ImageFit,
  ImageSource,
  Modifier,
  Shape,
  Size,
  TypographyStyle,
  VerticalAlignment,
} from "@parity/truapi";

/** Reports a user gesture inside a rendered tree back to the product. */
export type RendererActionHandler = (
  actionId: string,
  payload?: Uint8Array,
) => void;

/** Resources belong to one replacement tree, not to the message's lifetime. */
export interface RendererResources {
  signal: AbortSignal;
  loadImage(source: ImageSource, signal: AbortSignal): Promise<Blob>;
  onError(error: Error): void;
}

const IMAGE_FIT_CSS: Record<ImageFit, string> = {
  None: "none",
  Fill: "fill",
  Cover: "cover",
  Contain: "contain",
  ScaleDown: "scale-down",
};

const BLENDING_MODE_CSS: Record<BlendingMode, string> = {
  Normal: "normal",
  Multiply: "multiply",
  Screen: "screen",
  Overlay: "overlay",
  Darken: "darken",
  Lighten: "lighten",
  ColorDodge: "color-dodge",
  ColorBurn: "color-burn",
  HardLight: "hard-light",
  SoftLight: "soft-light",
  Difference: "difference",
  Exclusion: "exclusion",
  Hue: "hue",
  Saturation: "saturation",
  Color: "color",
  Luminosity: "luminosity",
};

function unreachable(value: never): never {
  throw new Error(`Unsupported renderer variant: ${JSON.stringify(value)}`);
}

// Semantic tokens resolve to chat-panel CSS custom properties so rendered
// trees follow the host theme, matching the desktop host's token mapping.
const COLOR_TOKEN_CSS: Record<ColorToken, string> = {
  FgPrimary: "var(--chat-fg-primary)",
  FgSecondary: "var(--chat-fg-secondary)",
  FgTertiary: "var(--chat-fg-tertiary)",
  BgSurfaceMain: "var(--chat-bg-surface-main)",
  BgSurfaceContainer: "var(--chat-bg-surface-container)",
  BgSurfaceNested: "var(--chat-bg-surface-nested)",
  FgSuccess: "var(--chat-fg-success)",
  FgError: "var(--chat-fg-error)",
  FgWarning: "var(--chat-fg-warning)",
};

const TYPOGRAPHY_CSS: Record<
  TypographyStyle,
  { fontSize: string; lineHeight: string; fontWeight: string }
> = {
  HeadlineLarge: { fontSize: "32px", lineHeight: "40px", fontWeight: "700" },
  TitleMediumRegular: {
    fontSize: "24px",
    lineHeight: "32px",
    fontWeight: "700",
  },
  BodyLargeRegular: { fontSize: "14px", lineHeight: "20px", fontWeight: "400" },
  BodyMediumRegular: {
    fontSize: "12px",
    lineHeight: "16px",
    fontWeight: "400",
  },
  BodySmallRegular: { fontSize: "10px", lineHeight: "14px", fontWeight: "400" },
};

const ARRANGEMENT_TO_JUSTIFY: Record<Arrangement, string> = {
  Start: "flex-start",
  End: "flex-end",
  Center: "center",
  SpaceBetween: "space-between",
  SpaceAround: "space-around",
  SpaceEvenly: "space-evenly",
};

const HORIZONTAL_TO_FLEX: Record<HorizontalAlignment, string> = {
  Start: "flex-start",
  Center: "center",
  End: "flex-end",
};

const VERTICAL_TO_FLEX: Record<VerticalAlignment, string> = {
  Top: "flex-start",
  Center: "center",
  Bottom: "flex-end",
};

const CONTENT_ALIGNMENT: Record<
  ContentAlignment,
  [alignItems: string, justifyItems: string]
> = {
  TopStart: ["start", "start"],
  TopCenter: ["start", "center"],
  TopEnd: ["start", "end"],
  CenterStart: ["center", "start"],
  Center: ["center", "center"],
  CenterEnd: ["center", "end"],
  BottomStart: ["end", "start"],
  BottomCenter: ["end", "center"],
  BottomEnd: ["end", "end"],
};

const textEncoder = new TextEncoder();

function px(value: Size): string {
  return `${String(Number(value))}px`;
}

function shapeToBorderRadius(shape: Shape | undefined): string | undefined {
  if (shape === undefined) {
    return undefined;
  }
  switch (shape.tag) {
    case "Circle":
      return "50%";
    case "Square":
      return "0px";
    case "Rounded":
      return px(shape.value);
    default:
      return unreachable(shape);
  }
}

// Two- and three-value CSS shorthands carry the spec's defaulting rules:
// bottom falls back to top, start falls back to end.
function dimensionsToCss(dims: Dimensions): string {
  if (dims.start !== undefined) {
    return `${px(dims.top)} ${px(dims.end)} ${px(dims.bottom ?? dims.top)} ${px(dims.start)}`;
  }
  if (dims.bottom !== undefined) {
    return `${px(dims.top)} ${px(dims.end)} ${px(dims.bottom)}`;
  }
  return `${px(dims.top)} ${px(dims.end)}`;
}

function applyModifiers(
  style: CSSStyleDeclaration,
  modifiers: Modifier[],
): void {
  for (const mod of modifiers) {
    switch (mod.tag) {
      case "Margin":
        style.margin = dimensionsToCss(mod.value);
        break;
      case "Padding":
        style.padding = dimensionsToCss(mod.value);
        break;
      case "Background": {
        style.backgroundColor = COLOR_TOKEN_CSS[mod.value.color];
        const radius = shapeToBorderRadius(mod.value.shape);
        if (radius !== undefined) {
          style.borderRadius = radius;
        }
        break;
      }
      case "Border": {
        style.borderWidth = px(mod.value.width);
        style.borderColor = COLOR_TOKEN_CSS[mod.value.color];
        style.borderStyle = "solid";
        const radius = shapeToBorderRadius(mod.value.shape);
        if (radius !== undefined) {
          style.borderRadius = radius;
        }
        break;
      }
      case "Height":
        style.height = px(mod.value);
        break;
      case "Width":
        style.width = px(mod.value);
        break;
      case "MinWidth":
        style.minWidth = px(mod.value);
        break;
      case "MinHeight":
        style.minHeight = px(mod.value);
        break;
      case "FillWidth":
        style.width = mod.value ? "100%" : "";
        break;
      case "FillHeight":
        style.height = mod.value ? "100%" : "";
        break;
      case "Opacity":
        style.opacity = String(mod.value / 255);
        break;
      case "BlendingMode":
        style.mixBlendMode = BLENDING_MODE_CSS[mod.value];
        break;
      default:
        unreachable(mod);
    }
  }
}

function appendChildren(
  parent: HTMLElement,
  children: RendererNode[],
  onAction: RendererActionHandler,
  resources?: RendererResources,
): void {
  for (const child of children) {
    const rendered = renderNode(child, onAction, resources);
    if (rendered !== null) {
      parent.appendChild(rendered);
    }
  }
}

/**
 * One node of a product-authored render tree, as host UI. Text lands via
 * `textContent`/text nodes, so product strings can never inject markup.
 */
export function renderNode(
  node: RendererNode,
  onAction: RendererActionHandler,
  resources?: RendererResources,
): globalThis.Node | null {
  switch (node.tag) {
    case "Nil":
      return null;

    case "String":
      return document.createTextNode(node.value.text);

    case "Box": {
      const { modifiers, props, children } = node.value;
      const box = document.createElement("div");
      box.className = "chat-custom-box";
      const alignment =
        props.contentAlignment === undefined
          ? undefined
          : CONTENT_ALIGNMENT[props.contentAlignment];
      if (alignment !== undefined) {
        box.style.alignItems = alignment[0];
        box.style.justifyItems = alignment[1];
      }
      applyModifiers(box.style, modifiers);
      appendChildren(box, children, onAction, resources);
      return box;
    }

    case "Column": {
      const { modifiers, props, children } = node.value;
      const column = document.createElement("div");
      column.className = "chat-custom-column";
      if (props.horizontalAlignment !== undefined) {
        column.style.alignItems = HORIZONTAL_TO_FLEX[props.horizontalAlignment];
      }
      if (props.verticalArrangement !== undefined) {
        column.style.justifyContent =
          ARRANGEMENT_TO_JUSTIFY[props.verticalArrangement];
      }
      applyModifiers(column.style, modifiers);
      appendChildren(column, children, onAction, resources);
      return column;
    }

    case "Row": {
      const { modifiers, props, children } = node.value;
      const row = document.createElement("div");
      row.className = "chat-custom-row";
      if (props.horizontalArrangement !== undefined) {
        row.style.justifyContent =
          ARRANGEMENT_TO_JUSTIFY[props.horizontalArrangement];
      }
      if (props.verticalAlignment !== undefined) {
        row.style.alignItems = VERTICAL_TO_FLEX[props.verticalAlignment];
      }
      applyModifiers(row.style, modifiers);
      appendChildren(row, children, onAction, resources);
      return row;
    }

    case "Spacer": {
      const { modifiers } = node.value;
      const spacer = document.createElement("div");
      spacer.className = "chat-custom-spacer";
      applyModifiers(spacer.style, modifiers);
      return spacer;
    }

    case "Text": {
      const { modifiers, props, children } = node.value;
      const text = document.createElement("span");
      text.className = "chat-custom-text";
      if (props.style !== undefined) {
        const typography = TYPOGRAPHY_CSS[props.style];
        text.style.fontSize = typography.fontSize;
        text.style.lineHeight = typography.lineHeight;
        text.style.fontWeight = typography.fontWeight;
      }
      if (props.color !== undefined) {
        text.style.color = COLOR_TOKEN_CSS[props.color];
      }
      applyModifiers(text.style, modifiers);
      appendChildren(text, children, onAction, resources);
      return text;
    }

    case "Button": {
      const { modifiers, props, children } = node.value;
      const button = document.createElement("button");
      button.type = "button";
      const variant =
        props.variant === "Primary" || props.variant === undefined
          ? "primary"
          : props.variant === "Secondary"
            ? "secondary"
            : "text";
      button.className = `chat-custom-btn chat-custom-btn-${variant}`;
      button.textContent = props.text;
      appendChildren(button, children, onAction, resources);
      button.disabled = props.enabled === false || props.loading === true;
      button.classList.toggle(
        "chat-custom-btn-loading",
        props.loading === true,
      );
      const clickAction = props.clickAction;
      if (clickAction !== undefined) {
        button.addEventListener("click", () => {
          onAction(clickAction);
        });
      }
      applyModifiers(button.style, modifiers);
      return button;
    }

    case "TextField": {
      const { modifiers, props } = node.value;
      const field = document.createElement("div");
      field.className = "chat-custom-field";
      if (props.label !== undefined && props.label !== "") {
        const label = document.createElement("label");
        label.className = "chat-custom-field-label";
        label.textContent = props.label;
        field.appendChild(label);
      }
      const input = document.createElement("input");
      input.type = "text";
      input.className = "chat-custom-field-input";
      input.value = props.text;
      if (props.placeholder !== undefined) {
        input.placeholder = props.placeholder;
      }
      input.disabled = props.enabled === false;
      const valueChangeAction = props.valueChangeAction;
      if (valueChangeAction !== undefined) {
        input.addEventListener("input", () => {
          onAction(valueChangeAction, textEncoder.encode(input.value));
        });
      }
      field.appendChild(input);
      applyModifiers(field.style, modifiers);
      return field;
    }

    case "Image": {
      if (resources === undefined) {
        throw new Error("Image rendering requires host resources");
      }
      const { modifiers, props } = node.value;
      const image = document.createElement("img");
      image.className = "chat-custom-image";
      // The protocol has no alternative-text field; accompanying Text nodes
      // carry descriptions. Never expose the opaque source as a URL or label.
      image.alt = "";
      image.style.objectFit = IMAGE_FIT_CSS[props.fit ?? "Fill"];
      applyModifiers(image.style, modifiers);
      const { signal } = resources;
      image.addEventListener(
        "error",
        () => {
          if (!signal.aborted) {
            resources.onError(new Error("Renderer image could not be decoded"));
          }
        },
        { signal },
      );
      void resources
        .loadImage(props.source, signal)
        .then((blob) => {
          if (signal.aborted) {
            return;
          }
          const url = URL.createObjectURL(blob);
          signal.addEventListener(
            "abort",
            () => {
              image.removeAttribute("src");
              URL.revokeObjectURL(url);
            },
            { once: true },
          );
          image.src = url;
        })
        .catch((error: unknown) => {
          if (!signal.aborted) {
            resources.onError(
              error instanceof Error ? error : new Error(String(error)),
            );
          }
        });
      return image;
    }

    case "Effect": {
      if (resources === undefined) {
        throw new Error("Effect rendering requires host resources");
      }
      const effect = document.createElement("div");
      effect.className = "chat-custom-effect";
      effect.style.position = "relative";
      effect.style.isolation = "isolate";
      appendChildren(effect, node.value.children, onAction, resources);
      const tint = document.createElement("span");
      tint.setAttribute("aria-hidden", "true");
      tint.style.position = "absolute";
      tint.style.inset = "0";
      tint.style.pointerEvents = "none";
      tint.style.mixBlendMode = "color";
      tint.style.background =
        "linear-gradient(90deg, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)";
      effect.appendChild(tint);
      if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        const animation = tint.animate(
          [{ filter: "hue-rotate(0deg)" }, { filter: "hue-rotate(360deg)" }],
          { duration: 4000, iterations: Infinity },
        );
        resources.signal.addEventListener(
          "abort",
          () => {
            animation.cancel();
          },
          { once: true },
        );
      }
      return effect;
    }

    default:
      return unreachable(node);
  }
}
