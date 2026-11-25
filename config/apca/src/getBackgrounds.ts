// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import axe from 'axe-core';
import type { Color } from './axeCommons.js';
import { getGradientBackgrounds } from './getGradientBackgrounds.js';

/**
 * Lists the backgrounds a text element may sit on: the one axe tells, or else each color stop of a gradient flattened
 * over the layers beneath it. Returns an empty list when neither can be told.
 */
export function getBackgrounds(node: Element): Color[] {
  const { color, dom } = axe.commons;
  const background = color.getBackgroundColor(node, []);
  if (background) {
    return [background];
  }
  const stack = color.getBackgroundStack(node);
  if (!stack) {
    return [];
  }
  return getGradientBackgrounds({
    text: {
      style: getComputedStyle(node),
      ancestors: getAncestorStyles(node),
      rects: dom.getVisibleChildTextRects(node),
    },
    stack: stack.map(element => ({
      nodeName: element.nodeName,
      isBody: element === document.body,
      box: element.getBoundingClientRect(),
      style: getComputedStyle(element),
      ancestors: getAncestorStyles(element),
    })),
  });
}

function getAncestorStyles(element: Element) {
  const styles: CSSStyleDeclaration[] = [];
  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
    styles.push(getComputedStyle(ancestor));
  }
  return styles;
}
