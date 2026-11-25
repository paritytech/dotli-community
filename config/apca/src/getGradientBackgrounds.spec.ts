// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { getGradientBackgrounds, type LayerSnapshot, type TextSnapshot } from './getGradientBackgrounds.js';

const PLAIN = { opacity: '1', mixBlendMode: 'normal' };
const HALF_OPAQUE = { opacity: '0.5', mixBlendMode: 'normal' };
const BLACK_TO_GRAY = 'linear-gradient(rgb(0, 0, 0), rgb(51, 51, 51))';

describe('getGradientBackgrounds', () => {
  it.each([
    {
      shape: 'an opaque gradient card',
      stack: [layer(), layer({ backgroundImage: BLACK_TO_GRAY }), body()],
      backgrounds: ['#000000', '#333333'],
    },
    {
      shape: 'a translucent gradient over its own color',
      stack: [
        layer({
          backgroundImage: 'linear-gradient(rgba(0, 0, 0, 0.5), rgba(0, 0, 0, 0))',
          backgroundColor: 'rgb(255, 0, 0)',
        }),
        body(),
      ],
      backgrounds: ['#800000', '#ff0000'],
    },
    {
      shape: 'a translucent gradient in a stack with nothing opaque',
      stack: [layer({ backgroundImage: 'linear-gradient(rgba(0, 0, 0, 0.5), rgba(0, 0, 0, 0.5))' }), body()],
      backgrounds: ['#808080', '#808080'],
    },
    {
      shape: 'a gradient drawn once at a percentage position',
      stack: [
        layer({ backgroundImage: BLACK_TO_GRAY, backgroundRepeat: 'no-repeat', backgroundPosition: '50% 0%' }),
        body(),
      ],
      backgrounds: ['#000000', '#333333'],
    },
    {
      shape: 'a gradient card over a translucent element it hides',
      stack: [
        layer({ backgroundImage: BLACK_TO_GRAY }),
        layer({ backgroundColor: 'rgb(255, 0, 0)', ...HALF_OPAQUE }),
        body(),
      ],
      backgrounds: ['#000000', '#333333'],
    },
  ])('As a story author, I check text over $shape and get its colors', ({ stack, backgrounds }) => {
    // Given
    const params = { text: text(), stack };

    // When
    const colors = getGradientBackgrounds(params);

    // Then
    expect(colors.map(c => c.toHexString())).toEqual(backgrounds);
  });

  it.each([
    { shape: 'no gradient', text: text(), stack: [layer({ backgroundColor: 'rgba(0, 0, 0, 0.5)' }), body()] },
    {
      shape: 'an image',
      text: text(),
      stack: [layer({ backgroundImage: `${BLACK_TO_GRAY}, url("https://example.com/a.png")` }), body()],
    },
    {
      shape: 'a graphic element',
      text: text(),
      stack: [layer({ backgroundImage: BLACK_TO_GRAY }, { nodeName: 'img' }), body()],
    },
    {
      shape: 'a sized gradient',
      text: text(),
      stack: [layer({ backgroundImage: BLACK_TO_GRAY, backgroundSize: '200% 100%' }), body()],
    },
    {
      shape: 'a gradient blended with its color',
      text: text(),
      stack: [layer({ backgroundImage: BLACK_TO_GRAY, backgroundBlendMode: 'multiply' }), body()],
    },
    {
      shape: 'a gradient drawn once at a length offset',
      text: text(),
      stack: [
        layer({ backgroundImage: BLACK_TO_GRAY, backgroundRepeat: 'no-repeat', backgroundPosition: '300px 0%' }),
        body(),
      ],
    },
    {
      shape: 'a gradient clipped to its own text',
      text: text(),
      stack: [layer(), layer({ backgroundImage: BLACK_TO_GRAY, backgroundClip: 'text' }), body()],
    },
    {
      shape: 'a gradient that covers part of the text',
      text: text(),
      stack: [layer({ backgroundImage: BLACK_TO_GRAY }, { box: { top: 0, bottom: 100, left: 0, right: 20 } }), body()],
    },
    {
      shape: 'a color axe cannot read',
      text: text(),
      stack: [layer({ backgroundImage: BLACK_TO_GRAY, backgroundColor: 'color-mix(in srgb, red, blue)' }), body()],
    },
    {
      shape: 'a translucent gradient over a stack without the body',
      text: text(),
      stack: [layer({ backgroundImage: 'linear-gradient(rgba(0, 0, 0, 0.5), rgba(0, 0, 0, 0.5))' })],
    },
    {
      shape: 'a gradient, in a text shadow',
      text: text({ textShadow: 'rgb(0, 0, 0) 1px 1px 0px' }),
      stack: cardStack(),
    },
    {
      shape: 'a gradient, in translucent text',
      text: text({ webkitTextFillColor: 'rgba(255, 255, 255, 0.5)' }),
      stack: cardStack(),
    },
    { shape: 'a gradient, in text under a translucent ancestor', text: text({}, [HALF_OPAQUE]), stack: cardStack() },
    {
      shape: 'a gradient card in a translucent parent',
      text: text(),
      stack: [layer({ backgroundImage: BLACK_TO_GRAY }, { ancestors: [HALF_OPAQUE] }), body()],
    },
  ])('As a story author, I check text over $shape and get no colors', ({ text, stack }) => {
    // Given
    const params = { text, stack };

    // When
    const colors = getGradientBackgrounds(params);

    // Then
    expect(colors).toEqual([]);
  });
});

function text(style: Partial<TextSnapshot['style']> = {}, ancestors: TextSnapshot['ancestors'] = []): TextSnapshot {
  return {
    style: { color: 'rgb(255, 255, 255)', webkitTextFillColor: '', textShadow: 'none', ...PLAIN, ...style },
    ancestors,
    rects: [{ top: 10, bottom: 30, left: 10, right: 90 }],
  };
}

function layer(style: Partial<LayerSnapshot['style']> = {}, snapshot: Partial<Omit<LayerSnapshot, 'style'>> = {}) {
  return {
    nodeName: 'DIV',
    isBody: false,
    box: { top: 0, bottom: 100, left: 0, right: 100 },
    ancestors: [],
    style: {
      backgroundImage: 'none',
      backgroundColor: 'rgba(0, 0, 0, 0)',
      backgroundSize: 'auto',
      backgroundBlendMode: 'normal',
      backgroundClip: 'border-box',
      backgroundRepeat: 'repeat',
      backgroundPosition: '0% 0%',
      display: 'block',
      ...PLAIN,
      ...style,
    },
    ...snapshot,
  } satisfies LayerSnapshot;
}

function body() {
  return layer({ backgroundColor: 'rgb(255, 255, 255)' }, { nodeName: 'BODY', isBody: true });
}

function cardStack() {
  return [layer({ backgroundImage: BLACK_TO_GRAY }), body()];
}
