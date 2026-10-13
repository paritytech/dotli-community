// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The closed mapping from a product's layout names and design tokens to the host's style values.

import { describe, expect, it } from 'vitest';
import { boxStyle, columnStyle, modifierStyle, rowStyle, textStyle } from './custom-styles.js';

describe('chat custom styles', () => {
  it('As a product, a column maps its alignment, arrangement, padding and rounded background', () => {
    // When
    const style = columnStyle('Center', 'SpaceBetween', [
      { tag: 'Padding', value: { top: 12, end: 8 } },
      { tag: 'Background', value: { color: 'BgSurfaceContainer', shape: { tag: 'Rounded', value: 10 } } },
    ]);

    // Then
    expect(style).toEqual({
      'align-items': 'center',
      'justify-content': 'space-between',
      padding: '12px 8px',
      'background-color': 'var(--chat-bg-surface-container)',
      'border-radius': '10px',
    });
  });

  it('As a product, text maps its typography and color token', () => {
    // When
    const style = textStyle('HeadlineLarge', 'FgError', []);

    // Then
    expect(style).toEqual({
      'font-size': '32px',
      'line-height': '40px',
      'font-weight': '700',
      color: 'var(--chat-fg-error)',
    });
  });

  it('As a product, a row maps its arrangement, alignment and full width', () => {
    // When
    const style = rowStyle('End', 'Bottom', [{ tag: 'FillWidth', value: true }]);

    // Then
    expect(style).toEqual({ 'justify-content': 'flex-end', 'align-items': 'flex-end', width: '100%' });
  });

  it('As a product, a box maps its content alignment, minimum height and circular border', () => {
    // When
    const style = boxStyle('BottomEnd', [
      { tag: 'MinHeight', value: 40 },
      { tag: 'Border', value: { width: 1, color: 'FgTertiary', shape: { tag: 'Circle' } } },
    ]);

    // Then
    expect(style).toEqual({
      'align-items': 'end',
      'justify-items': 'end',
      'min-height': '40px',
      'border-width': '1px',
      'border-color': 'var(--chat-fg-tertiary)',
      'border-style': 'solid',
      'border-radius': '50%',
    });
  });

  it('As a product, four-sided dimensions and sizing modifiers apply', () => {
    // When
    const style = modifierStyle([
      { tag: 'Margin', value: { top: 1, end: 2, bottom: 3, start: 4 } },
      { tag: 'Width', value: 120 },
      { tag: 'Height', value: 60 },
      { tag: 'MinWidth', value: 80 },
    ]);

    // Then
    expect(style).toEqual({ margin: '1px 2px 3px 4px', width: '120px', height: '60px', 'min-width': '80px' });
  });

  it('As a product, three-sided dimensions take the start from the end', () => {
    // When
    const style = modifierStyle([{ tag: 'Padding', value: { top: 1, end: 2, bottom: 3 } }]);

    // Then
    expect(style).toEqual({ padding: '1px 2px 3px' });
  });

  it('As a product, opacity, blending and a square background map onto style values', () => {
    // When
    const style = modifierStyle([
      { tag: 'Opacity', value: 51 },
      { tag: 'BlendingMode', value: 'Multiply' },
      { tag: 'Background', value: { color: 'BgSurfaceMain', shape: { tag: 'Square' } } },
    ]);

    // Then
    expect(style).toEqual({
      opacity: '0.2',
      'mix-blend-mode': 'multiply',
      'background-color': 'var(--chat-bg-surface-main)',
      'border-radius': '0',
    });
  });

  it('As a product, a later modifier wins and a fill I turn off sets nothing', () => {
    // When
    const style = modifierStyle([
      { tag: 'Width', value: 24 },
      { tag: 'FillWidth', value: true },
      { tag: 'FillHeight', value: false },
    ]);

    // Then
    expect(style).toEqual({ width: '100%' });
  });

  it('As a product, a layout without alignment or modifiers adds no style', () => {
    // Then
    expect(boxStyle(undefined, [])).toEqual({});
    expect(columnStyle(undefined, undefined, [])).toEqual({});
    expect(rowStyle(undefined, undefined, [])).toEqual({});
    expect(textStyle(undefined, undefined, [])).toEqual({});
  });
});
