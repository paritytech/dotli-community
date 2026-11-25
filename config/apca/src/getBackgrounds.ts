// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import axe from 'axe-core';
import type { Color } from './axeCommons.js';
import { parseGradientStops } from './parseGradientStops.js';

// The elements axe treats as an image under the text.
const GRAPHIC_NODES = new Set(['IMG', 'CANVAS', 'OBJECT', 'IFRAME', 'VIDEO', 'SVG']);

/**
 * Lists the backgrounds a text element may sit on: the one axe tells, or else each color stop of a gradient flattened
 * over the layers beneath it. Returns an empty list when neither can be told.
 */
export function getBackgrounds(node: Element): Color[] {
  const { color } = axe.commons;
  const background = color.getBackgroundColor(node, []);
  if (background) {
    return [background];
  }
  // axe gives up on any background image. Only a gradient is resolved here.
  if (color.incompleteData.get('bgColor') !== 'bgGradient') {
    return [];
  }
  try {
    return getGradientBackgrounds(node);
  } catch (error) {
    // A color axe cannot read leaves the text without a verdict, as in axe's own walk.
    if (color.incompleteData.get('colorParse') !== undefined) {
      return [];
    }
    throw error;
  }
}

function getGradientBackgrounds(node: Element) {
  const { color } = axe.commons;
  const stack = color.getBackgroundStack(node);
  // axe folds text shadows, translucent text and the opacity and blending of stacking contexts into its colors. This
  // walk does not, so it gives up on them.
  if (!stack || !hasPlainText(node) || hasCompositing(node, stack)) {
    return [];
  }
  const textRects = axe.commons.dom.getVisibleChildTextRects(node);
  // Each layer lists the colors it may paint under the text, the topmost layer first.
  const layers: Color[][] = [];
  for (const element of stack) {
    const own = getOwnLayers(element, textRects);
    if (!own) {
      return [];
    }
    layers.push(...own);
    if (own.some(isOpaque)) {
      break;
    }
  }
  const bottom = layers.findIndex(isOpaque);
  // Under a stack without the body, axe adds the page's own background, which this walk does not.
  if (bottom === -1 && !stack.includes(document.body)) {
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
function getOwnLayers(element: Element, textRects: DOMRect[]): Color[][] | null {
  const { color } = axe.commons;
  const style = getComputedStyle(element);
  const gradients = parseGradientStops(style.backgroundImage);
  if (!gradients || GRAPHIC_NODES.has(element.nodeName.toUpperCase()) || !isPlainImage(style, gradients)) {
    return null;
  }
  // An element paints its background color beneath its images.
  const own = [
    ...gradients.map(stops => stops.map(stop => new color.Color().parseString(stop))),
    [color.getOwnBackgroundColor(style)],
  ].filter(layer => layer.some(c => c.alpha > 0));
  if (own.length > 0 && style.display !== 'inline' && !coversText(element, textRects)) {
    return null;
  }
  return own;
}

function hasPlainText(node: Element) {
  const style = getComputedStyle(node);
  const fill = new axe.commons.color.Color().parseString(
    style.getPropertyValue('-webkit-text-fill-color') || style.color,
  );
  return style.textShadow === 'none' && fill.alpha === 1;
}

function hasCompositing(node: Element, stack: Element[]) {
  for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (isComposited(ancestor)) {
      return true;
    }
  }
  return stack.some(isComposited);
}

function isComposited(element: Element) {
  const style = getComputedStyle(element);
  return style.opacity !== '1' || style.mixBlendMode !== 'normal';
}

// A gradient sized or blended apart from its element's background paints colors its stops do not name.
function isPlainImage(style: CSSStyleDeclaration, gradients: string[][]) {
  if (gradients.length === 0) {
    return true;
  }
  const isNormal = (values: string, normal: string) => values.split(',').every(value => value.trim() === normal);
  return isNormal(style.backgroundSize, 'auto') && isNormal(style.backgroundBlendMode, 'normal');
}

function coversText(element: Element, textRects: DOMRect[]) {
  const box = element.getBoundingClientRect();
  return textRects.every(
    rect => rect.top >= box.top && rect.bottom <= box.bottom && rect.left >= box.left && rect.right <= box.right,
  );
}

function isOpaque(layer: Color[]) {
  return layer.every(c => c.alpha === 1);
}
