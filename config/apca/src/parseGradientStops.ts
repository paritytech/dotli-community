// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

const GRADIENT = /^((?:-webkit-)?(?:repeating-)?(?:linear|radial|conic)-gradient)\((.*)\)$/s;
// The forms of a computed color that axe reads. A computed style never gives a color as a keyword.
const COLOR = /^(?:#|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\()/i;
const POSITION = /^(?:-?[\d.]+[a-z%]*|calc\(.*\))$/i;
const NOT_GEOMETRY = /^(?!calc\()[a-z-]+\(/i;

/**
 * Splits a computed `background-image` into the color stops of each gradient, the topmost gradient first. Returns an
 * empty list for `none`, and null when a layer is not a gradient, sets a color space or hue path of its own, or holds a
 * stop with no color it can read.
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

/** Tells whether a computed color is in a form axe reads. */
export function isColorValue(value: string): boolean {
  return COLOR.test(value);
}

function parseStops(body: string) {
  const stops: string[] = [];
  for (const [index, argument] of splitOutsideParentheses(body, /,/).entries()) {
    const tokens = splitOutsideParentheses(argument, /\s/);
    const color = tokens.find(token => isColorValue(token));
    if (color !== undefined) {
      stops.push(color);
      continue;
    }
    // The first argument may set the direction or shape, which holds no function but calc(). Interpolated in a color
    // space or along a hue path of its own, a gradient may paint colors far from its stops.
    if (index === 0 && (tokens.includes('in') || tokens.some(token => NOT_GEOMETRY.test(token)))) {
      return null;
    }
    // A later argument without a color is a bare hint.
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
