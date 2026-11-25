// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

const GRADIENT = /^((?:-webkit-)?(?:repeating-)?(?:linear|radial|conic)-gradient)\((.*)\)$/s;
// A computed style gives every color as a function or a hex value, never as a keyword.
const COLOR = /^(?:#|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\()/i;
const POSITION = /^(?:-?[\d.]+[a-z%]*|calc\(.*\))$/i;

/**
 * Splits a computed `background-image` into the color stops of each gradient, the topmost gradient first. Returns an
 * empty list for `none`, and null when a layer is not a gradient or a stop holds no color it can read.
 */
export function parseGradientStops(backgroundImage: string): string[][] | null {
  if (backgroundImage.trim() === 'none') {
    return [];
  }
  const gradients: string[][] = [];
  for (const layer of splitOutsideParentheses(backgroundImage, /,/)) {
    const body = GRADIENT.exec(layer)?.[2];
    if (body === undefined) {
      return null;
    }
    const stops = parseStops(body);
    if (!stops) {
      return null;
    }
    gradients.push(stops);
  }
  return gradients;
}

function parseStops(body: string) {
  const stops: string[] = [];
  for (const [index, argument] of splitOutsideParentheses(body, /,/).entries()) {
    const tokens = splitOutsideParentheses(argument, /\s/);
    const color = tokens.find(token => COLOR.test(token));
    if (color !== undefined) {
      stops.push(color);
      continue;
    }
    // The first argument may set the direction, shape or color space. A later one without a color is a bare hint.
    if (index > 0 && !tokens.every(token => POSITION.test(token))) {
      return null;
    }
  }
  return stops;
}

function splitOutsideParentheses(text: string, separator: RegExp) {
  const parts: string[] = [];
  let depth = 0;
  let part = '';
  for (const char of text) {
    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
    }
    if (depth > 0 || !separator.test(char)) {
      part += char;
      continue;
    }
    parts.push(part);
    part = '';
  }
  parts.push(part);
  // Runs of spaces leave empty parts.
  return parts.map(p => p.trim()).filter(p => p !== '');
}
