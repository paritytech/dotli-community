// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import axe from 'axe-core';
import type { Color } from './axeCommons.js';
import { isColorValue, parseGradientStops } from './parseGradientStops.js';

/** A box in viewport px. */
export type Box = Pick<DOMRect, 'top' | 'bottom' | 'left' | 'right'>;

/** The opacity, blending and filter an element applies to all it paints. */
export type Compositing = Pick<CSSStyleDeclaration, 'opacity' | 'mixBlendMode' | 'filter'>;

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
      | 'backgroundOrigin'
      | 'backgroundRepeat'
      | 'backgroundPosition'
      | 'backdropFilter'
      | 'display'
    > & {
      /** WebKit before 18 names its backdrop filter only with this prefix. */
      webkitBackdropFilter?: string;
    };
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
 * beneath it, or over opaque black and white where a backdrop filter hides them. Returns an empty list when a gradient
 * paints none of them, or when the walk cannot tell them.
 */
export function getGradientBackgrounds({ text, stack }: Params): Color[] {
  const { color } = axe.commons;
  // axe folds text shadows, translucent text and the opacity and blending of stacking contexts into its colors. This
  // walk does not, so it gives up on them. A filter may move any color anywhere.
  if (!hasPlainText(text.style) || [text.style, ...text.ancestors].some(isComposited)) {
    return [];
  }
  const walked = walkStack(stack, text.rects);
  if (!walked) {
    return [];
  }
  // Only a gradient is resolved here. Where the walk meets none, axe gave up for another reason, and its outcome
  // stands.
  if (!walked.read.some(element => element.style.backgroundImage !== 'none')) {
    return [];
  }
  const { layers, isBackdropUnknown } = walked;
  const bottom = layers.findIndex(isOpaque);
  // Under a stack without the body, axe adds the page's own background, which this walk does not.
  if (bottom === -1 && !isBackdropUnknown && !stack.some(element => element.isBody)) {
    return [];
  }
  const visible = bottom === -1 ? layers : layers.slice(0, bottom + 1);
  const white = new color.Color(255, 255, 255, 1);
  // White shows beneath the lowest layer, as axe takes it. Beneath a backdrop filter, black and white bound what shows.
  const beneath = isBackdropUnknown ? [new color.Color(0, 0, 0, 1), white] : [white];
  return visible.reduceRight(
    (backdrops, layer) => layer.flatMap(source => backdrops.map(backdrop => color.flattenColors(source, backdrop))),
    beneath,
  );
}

/**
 * Reads the stack from the top down to the first opaque layer or backdrop filter, and returns the elements it read and
 * the layers they paint under the text, or null when it cannot tell them.
 */
function walkStack(stack: readonly LayerSnapshot[], textRects: readonly Box[]) {
  // Each layer lists the colors it may paint under the text, the topmost layer first.
  const layers: Color[][] = [];
  const read: LayerSnapshot[] = [];
  for (const element of stack) {
    const own = getOwnLayers(element, textRects);
    if (!own) {
      return null;
    }
    read.push(element);
    layers.push(...own);
    if (own.some(isOpaque)) {
      return { layers, read, isBackdropUnknown: false };
    }
    // A backdrop filter shows the layers beneath it blurred and recolored, so the walk cannot read past it.
    if (hasBackdropFilter(element.style)) {
      return { layers, read, isBackdropUnknown: true };
    }
  }
  return { layers, read, isBackdropUnknown: false };
}

/** The layers an element paints under the text, the topmost first, or null when they cannot be told. */
function getOwnLayers({ nodeName, box, style, ancestors }: LayerSnapshot, textRects: readonly Box[]): Color[][] | null {
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
  // A background clipped to text, or to a box inside the border, paints only part of the element.
  if (!isEvery(style.backgroundClip, value => value === 'border-box')) {
    return null;
  }
  if (style.display !== 'inline' && !coversText(box, textRects)) {
    return null;
  }
  // Opacity, blending or a filter on the element or its ancestors changes the colors it paints.
  if ([style, ...ancestors].some(isComposited)) {
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
  return style.opacity !== '1' || style.mixBlendMode !== 'normal' || style.filter !== 'none';
}

function hasBackdropFilter(style: LayerSnapshot['style']) {
  return [style.backdropFilter, style.webkitBackdropFilter].some(value => value !== undefined && value !== 'none');
}

// A gradient paints only its stops' colors, blended as one layer, over all of its element where its one tile repeats,
// or sits at no offset in the element's border box. A percentage offsets nothing in the box the tile fills.
function isWholeGradient(style: LayerSnapshot['style']) {
  const covers =
    isEvery(style.backgroundRepeat, value => value === 'repeat') ||
    (isEvery(style.backgroundPosition, value => PERCENTAGE.test(value)) &&
      isEvery(style.backgroundOrigin, value => value === 'border-box'));
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
