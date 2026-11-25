// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import axe from 'axe-core';
import { scoreText } from './scoreText.js';

declare module 'axe-core' {
  // axe's color helpers are public but untyped. Only the calls this module makes are declared.
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- augmenting axe's Commons needs declaration merging
  interface Commons {
    color: {
      getBackgroundColor(node: Element, backgroundElements: Element[]): Color | null;
      getForegroundColor(node: Element, noScroll: boolean, background: Color): Color | null;
    };
  }
}

type Color = {
  red: number;
  green: number;
  blue: number;
  toHexString(): string;
};

const CHECK_ID = 'apca-bronze';

/** axe settings that replace the WCAG `color-contrast` rule with an APCA Bronze text contrast rule. */
export const axeConfig: axe.Spec = {
  rules: [
    { id: 'color-contrast', enabled: false },
    {
      id: 'apca-contrast',
      // axe's own selection of text for its contrast rule.
      matches: 'color-contrast-matches',
      all: [CHECK_ID],
      any: [],
      none: [],
      tags: ['cat.color', 'apca'],
      metadata: {
        description: 'Ensures text has enough APCA lightness contrast against its background',
        help: 'Text must meet the APCA Bronze minimum for its font size',
        helpUrl: 'https://github.com/Myndex/apca-w3',
      },
    },
  ],
  checks: [
    {
      id: CHECK_ID,
      evaluate: evaluateBronze,
      metadata: {
        impact: 'serious',
        messages: {
          // axe fills `${data.*}` from the check's data, so these are plain strings.
          pass: 'Lc ${data.lc} meets the Bronze minimum of Lc ${data.minimum} for ${data.fontSize}px text',
          fail:
            'Lc ${data.lc} is below the Bronze minimum of Lc ${data.minimum} for ${data.fontSize}px text ' +
            '(foreground ${data.foreground}, background ${data.background})',
          incomplete: 'Could not tell the text or background color, so APCA contrast was not scored',
        },
      },
    },
  ],
};

function evaluateBronze(this: axe.CheckHelper, node: Element): boolean | undefined {
  const background = axe.commons.color.getBackgroundColor(node, []);
  const foreground = background && axe.commons.color.getForegroundColor(node, false, background);
  // Text over an image or a gradient has no single color. axe files the node as incomplete, as its own rule does.
  if (!background || !foreground) {
    return undefined;
  }
  const fontSize = Number.parseFloat(getComputedStyle(node).fontSize);
  const { lc, minimum, passes } = scoreText({
    foreground: [foreground.red, foreground.green, foreground.blue],
    background: [background.red, background.green, background.blue],
    fontSize,
  });
  this.data({
    lc,
    minimum,
    fontSize,
    foreground: foreground.toHexString(),
    background: background.toHexString(),
  });
  return passes;
}
