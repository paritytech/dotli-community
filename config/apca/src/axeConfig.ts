// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import axe from 'axe-core';
import { getBackgrounds } from './getBackgrounds.js';
import { scoreText } from './scoreText.js';

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
  const pairs = [];
  for (const background of getBackgrounds(node)) {
    const foreground = axe.commons.color.getForegroundColor(node, false, background);
    if (!foreground) {
      return undefined;
    }
    pairs.push({ foreground, background });
  }
  const fontSize = Number.parseFloat(getComputedStyle(node).fontSize);
  const score = scoreText({ pairs, fontSize });
  // Text over an image, under another element or clipped has no color axe can tell. axe files the node as incomplete,
  // as its own rule does.
  if (!score) {
    return undefined;
  }
  this.data({
    lc: score.lc,
    minimum: score.minimum,
    fontSize,
    foreground: score.pair.foreground.toHexString(),
    background: score.pair.background.toHexString(),
  });
  return score.passes;
}
