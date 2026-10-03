// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Style mapping for product-authored render trees (components/chat/CustomNode).
//
// The tree is a closed vocabulary: the product names layouts and design
// tokens, never markup, styles, or URLs, so everything it can express is
// drawn from the host's own design system here and cannot reach past it.
// Protocol-level port of the desktop host's React renderer.
//
// Every builder returns a style object keyed by CSS property name, which is
// what a Solid `style` prop takes; a key that disappears on the next tree is
// removed from the element.

import type {
  Arrangement,
  BlendingMode,
  ColorToken,
  ContentAlignment,
  Dimensions,
  HorizontalAlignment,
  Modifier,
  Shape,
  Size,
  TypographyStyle,
  VerticalAlignment,
} from '@parity/truapi';

export type CustomStyle = Record<string, string>;

// Semantic tokens resolve to the chat palette in global.css (`--chat-*`),
// matching the desktop host's token mapping.
const COLOR_TOKEN_CSS: Record<ColorToken, string> = {
  FgPrimary: 'var(--chat-fg-primary)',
  FgSecondary: 'var(--chat-fg-secondary)',
  FgTertiary: 'var(--chat-fg-tertiary)',
  BgSurfaceMain: 'var(--chat-bg-surface-main)',
  BgSurfaceContainer: 'var(--chat-bg-surface-container)',
  BgSurfaceNested: 'var(--chat-bg-surface-nested)',
  FgSuccess: 'var(--chat-fg-success)',
  FgError: 'var(--chat-fg-error)',
  FgWarning: 'var(--chat-fg-warning)',
};

const TYPOGRAPHY_CSS: Record<TypographyStyle, CustomStyle> = {
  HeadlineLarge: {
    'font-size': '32px',
    'line-height': '40px',
    'font-weight': '700',
  },
  TitleMediumRegular: {
    'font-size': '24px',
    'line-height': '32px',
    'font-weight': '700',
  },
  BodyLargeRegular: {
    'font-size': '14px',
    'line-height': '20px',
    'font-weight': '400',
  },
  BodyMediumRegular: {
    'font-size': '12px',
    'line-height': '16px',
    'font-weight': '400',
  },
  BodySmallRegular: {
    'font-size': '10px',
    'line-height': '14px',
    'font-weight': '400',
  },
};

const ARRANGEMENT_TO_JUSTIFY: Record<Arrangement, string> = {
  Start: 'flex-start',
  End: 'flex-end',
  Center: 'center',
  SpaceBetween: 'space-between',
  SpaceAround: 'space-around',
  SpaceEvenly: 'space-evenly',
};

const HORIZONTAL_TO_FLEX: Record<HorizontalAlignment, string> = {
  Start: 'flex-start',
  Center: 'center',
  End: 'flex-end',
};

const VERTICAL_TO_FLEX: Record<VerticalAlignment, string> = {
  Top: 'flex-start',
  Center: 'center',
  Bottom: 'flex-end',
};

const CONTENT_ALIGNMENT: Record<ContentAlignment, [alignItems: string, justifyItems: string]> = {
  TopStart: ['start', 'start'],
  TopCenter: ['start', 'center'],
  TopEnd: ['start', 'end'],
  CenterStart: ['center', 'start'],
  Center: ['center', 'center'],
  CenterEnd: ['center', 'end'],
  BottomStart: ['end', 'start'],
  BottomCenter: ['end', 'center'],
  BottomEnd: ['end', 'end'],
};

const BLENDING_MODE_CSS: Record<BlendingMode, string> = {
  Normal: 'normal',
  Multiply: 'multiply',
  Screen: 'screen',
  Overlay: 'overlay',
  Darken: 'darken',
  Lighten: 'lighten',
  ColorDodge: 'color-dodge',
  ColorBurn: 'color-burn',
  HardLight: 'hard-light',
  SoftLight: 'soft-light',
  Difference: 'difference',
  Exclusion: 'exclusion',
  Hue: 'hue',
  Saturation: 'saturation',
  Color: 'color',
  Luminosity: 'luminosity',
};

function px(value: Size): string {
  return `${String(Number(value))}px`;
}

function shapeToBorderRadius(shape: Shape | undefined): string | undefined {
  if (shape === undefined) {
    return undefined;
  }
  switch (shape.tag) {
    case 'Rounded':
      return px(shape.value);
    case 'Circle':
      return '50%';
    case 'Square':
      return '0';
  }
}

// Two- and three-value CSS shorthands carry the spec's defaulting rules:
// bottom falls back to top, start falls back to end.
function dimensionsToCss(dims: Dimensions): string {
  if (dims.bottom !== undefined && dims.start !== undefined) {
    return `${px(dims.top)} ${px(dims.end)} ${px(dims.bottom)} ${px(dims.start)}`;
  }
  if (dims.bottom !== undefined) {
    return `${px(dims.top)} ${px(dims.end)} ${px(dims.bottom)}`;
  }
  return `${px(dims.top)} ${px(dims.end)}`;
}

/** The style `modifiers` give a node, later modifiers winning. */
export function modifierStyle(modifiers: Modifier[]): CustomStyle {
  const style: CustomStyle = {};
  for (const mod of modifiers) {
    switch (mod.tag) {
      case 'Margin':
        style['margin'] = dimensionsToCss(mod.value);
        break;
      case 'Padding':
        style['padding'] = dimensionsToCss(mod.value);
        break;
      case 'Background': {
        style['background-color'] = COLOR_TOKEN_CSS[mod.value.color];
        const radius = shapeToBorderRadius(mod.value.shape);
        if (radius !== undefined) {
          style['border-radius'] = radius;
        }
        break;
      }
      case 'Border': {
        style['border-width'] = px(mod.value.width);
        style['border-color'] = COLOR_TOKEN_CSS[mod.value.color];
        style['border-style'] = 'solid';
        const radius = shapeToBorderRadius(mod.value.shape);
        if (radius !== undefined) {
          style['border-radius'] = radius;
        }
        break;
      }
      case 'Height':
        style['height'] = px(mod.value);
        break;
      case 'Width':
        style['width'] = px(mod.value);
        break;
      case 'MinWidth':
        style['min-width'] = px(mod.value);
        break;
      case 'MinHeight':
        style['min-height'] = px(mod.value);
        break;
      case 'FillWidth':
        if (mod.value) {
          style['width'] = '100%';
        }
        break;
      case 'FillHeight':
        if (mod.value) {
          style['height'] = '100%';
        }
        break;
      // The wire carries a u8 alpha; CSS wants the unit interval.
      case 'Opacity':
        style['opacity'] = String(mod.value / 255);
        break;
      case 'BlendingMode':
        style['mix-blend-mode'] = BLENDING_MODE_CSS[mod.value];
        break;
    }
  }
  return style;
}

export function boxStyle(contentAlignment: ContentAlignment | undefined, modifiers: Modifier[]): CustomStyle {
  const alignment = contentAlignment === undefined ? undefined : CONTENT_ALIGNMENT[contentAlignment];
  return {
    ...(alignment === undefined ? {} : { 'align-items': alignment[0], 'justify-items': alignment[1] }),
    ...modifierStyle(modifiers),
  };
}

export function columnStyle(
  horizontalAlignment: HorizontalAlignment | undefined,
  verticalArrangement: Arrangement | undefined,
  modifiers: Modifier[],
): CustomStyle {
  return {
    ...(horizontalAlignment === undefined ? {} : { 'align-items': HORIZONTAL_TO_FLEX[horizontalAlignment] }),
    ...(verticalArrangement === undefined ? {} : { 'justify-content': ARRANGEMENT_TO_JUSTIFY[verticalArrangement] }),
    ...modifierStyle(modifiers),
  };
}

export function rowStyle(
  horizontalArrangement: Arrangement | undefined,
  verticalAlignment: VerticalAlignment | undefined,
  modifiers: Modifier[],
): CustomStyle {
  return {
    ...(horizontalArrangement === undefined
      ? {}
      : { 'justify-content': ARRANGEMENT_TO_JUSTIFY[horizontalArrangement] }),
    ...(verticalAlignment === undefined ? {} : { 'align-items': VERTICAL_TO_FLEX[verticalAlignment] }),
    ...modifierStyle(modifiers),
  };
}

export function textStyle(
  typography: TypographyStyle | undefined,
  color: ColorToken | undefined,
  modifiers: Modifier[],
): CustomStyle {
  return {
    ...(typography === undefined ? {} : TYPOGRAPHY_CSS[typography]),
    ...(color === undefined ? {} : { color: COLOR_TOKEN_CSS[color] }),
    ...modifierStyle(modifiers),
  };
}
