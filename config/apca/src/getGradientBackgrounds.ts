// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import axe from 'axe-core';
import type { Color } from './axeCommons.js';
import { isColorValue, parseGradientStops } from './parseGradientStops.js';

/** A box in viewport px. */
export type Box = Pick<DOMRect, 'top' | 'bottom' | 'left' | 'right'>;

/** The opacity and blending an element applies to all it paints. */
export type Compositing = Pick<CSSStyleDeclaration, 'opacity' | 'mixBlendMode'>;

/** The text element as it paints its glyphs. */
export type TextSnapshot = {
  style: Compositing & Pick<CSSStyleDeclaration, 'color' | 'webkitTextFillColor' | 'textShadow'>;
  /** Each ancestor's compositing, the parent first. */
  ancestors: readonly Compositing[];
  rects: readonly Box[];
};

/** One element under the text, as it paints its background. */
export type LayerSnapshot = {
  nodeName: string;
  isBody: boolean;
  box: Box;
  style: Compositing &
    Pick<
      CSSStyleDeclaration,
      | 'backgroundImage'
      | 'backgroundColor'
      | 'backgroundSize'
      | 'backgroundBlendMode'
      | 'backgroundClip'
      | 'backgroundRepeat'
      | 'backgroundPosition'
      | 'display'
    >;
  /** Each ancestor's compositing, the parent first. */
  ancestors: readonly Compositing[];
};

type Params = {
  text: TextSnapshot;
  /** The elements under the text, the topmost first. */
  stack: readonly LayerSnapshot[];
};

// A replaced or embedded element paints content that no style of it tells.
const GRAPHIC_NODES = new Set(['IMG', 'CANVAS', 'OBJECT', 'IFRAME', 'VIDEO', 'SVG']);
const PERCENTAGE = /^-?[\d.]+%$/;

/**
 * Lists the backgrounds text may sit on where a gradient paints under it: each color stop, flattened over the layers
 * beneath it. Returns an empty list when a gradient paints none of them, or when the walk cannot tell them.
 */
export function getGradientBackgrounds({ text, stack }: Params): Color[] {
  const { color } = axe.commons;
  // axe folds text shadows, translucent text and the opacity and blending of stacking contexts into its colors. This
  // walk does not, so it gives up on them.
  if (!hasPlainText(text.style) || [text.style, ...text.ancestors].some(isComposited)) {
    return [];
  }
  // Each layer lists the colors it may paint under the text, the topmost layer first.
  const layers: Color[][] = [];
  const read: LayerSnapshot[] = [];
  const painters: LayerSnapshot[] = [];
  for (const element of stack) {
    const own = getOwnLayers(element, text.rects);
    if (!own) {
      return [];
    }
    read.push(element);
    if (own.length > 0) {
      painters.push(element);
    }
    layers.push(...own);
    if (own.some(isOpaque)) {
      break;
    }
  }
  // Only a gradient is resolved here. Where the walk meets none, axe gave up for another reason, and its outcome
  // stands.
  if (!read.some(element => element.style.backgroundImage !== 'none')) {
    return [];
  }
  // Opacity or blending on an element that paints under the text, or on its ancestors, changes the colors it paints.
  if (painters.some(element => [element.style, ...element.ancestors].some(isComposited))) {
    return [];
  }
  const bottom = layers.findIndex(isOpaque);
  // Under a stack without the body, axe adds the page's own background, which this walk does not.
  if (bottom === -1 && !stack.some(element => element.isBody)) {
    return [];
  }
  const visible = bottom === -1 ? layers : layers.slice(0, bottom + 1);
  // White shows beneath the lowest layer, as axe takes it.
  return visible.reduceRight(
    (backdrops, layer) => layer.flatMap(source => backdrops.map(backdrop => color.flattenColors(source, backdrop))),
    [new color.Color(255, 255, 255, 1)],
  );
}

/** The layers an element paints under the text, the topmost first, or null when they cannot be told. */
function getOwnLayers({ nodeName, box, style }: LayerSnapshot, textRects: readonly Box[]): Color[][] | null {
  const gradients = parseGradientStops(style.backgroundImage);
  if (!gradients || GRAPHIC_NODES.has(nodeName.toUpperCase()) || !isColorValue(style.backgroundColor)) {
    return null;
  }
  if (gradients.length > 0 && !isWholeGradient(style)) {
    return null;
  }
  // An element paints its background color beneath its images.
  const own = [...gradients, [style.backgroundColor]]
    .map(layer => layer.map(value => new axe.commons.color.Color().parseString(value)))
    .filter(layer => layer.some(c => c.alpha > 0));
  if (own.length === 0) {
    return own;
  }
  // A background clipped to text paints only inside the glyphs, never around the text.
  if (!isEvery(style.backgroundClip, value => value !== 'text')) {
    return null;
  }
  if (style.display !== 'inline' && !coversText(box, textRects)) {
    return null;
  }
  return own;
}

function hasPlainText(style: TextSnapshot['style']) {
  const fill = style.webkitTextFillColor || style.color;
  return (
    style.textShadow === 'none' && isColorValue(fill) && new axe.commons.color.Color().parseString(fill).alpha === 1
  );
}

function isComposited(style: Compositing) {
  return style.opacity !== '1' || style.mixBlendMode !== 'normal';
}

// A gradient paints only its stops' colors, blended as one layer, over all of its element where its one tile, at the
// element's size, repeats or sits at no offset. A percentage offsets nothing at that size.
function isWholeGradient(style: LayerSnapshot['style']) {
  const covers =
    isEvery(style.backgroundRepeat, value => value === 'repeat') ||
    isEvery(style.backgroundPosition, value => PERCENTAGE.test(value));
  return (
    covers &&
    isEvery(style.backgroundSize, value => value === 'auto') &&
    isEvery(style.backgroundBlendMode, value => value === 'normal')
  );
}

// A computed list holds a value per layer, and a value may hold a word per axis.
function isEvery(list: string, test: (word: string) => boolean) {
  return list.split(/[\s,]+/).every(test);
}

function coversText(box: Box, textRects: readonly Box[]) {
  return textRects.every(
    rect => rect.top >= box.top && rect.bottom <= box.bottom && rect.left >= box.left && rect.right <= box.right,
  );
}

function isOpaque(layer: Color[]) {
  return layer.every(c => c.alpha === 1);
}
