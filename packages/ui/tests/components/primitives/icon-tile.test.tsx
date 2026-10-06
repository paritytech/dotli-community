// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { IconTile } from '../../../src/components/primitives/IconTile.js';
import { renderComponent } from '../../helpers/solid.js';
import { byTestId } from '../../support.js';

describe('IconTile', () => {
  it('As a user, I see the icon a prompt carries as markup in its tile, which assistive technology skips', () => {
    // Given / When
    renderComponent(() => <IconTile markup='<svg data-testid="glyph"></svg>' testId="tile" />);

    // Then
    const tile = byTestId('tile');
    expect(tile.tagName).toBe('DIV');
    expect(tile.getAttribute('aria-hidden')).toBe('true');
    expect(byTestId('glyph', tile, SVGElement).tagName.toLowerCase()).toBe('svg');
  });

  it('As a user, I see an icon a component draws itself in the same tile', () => {
    // Given / When
    renderComponent(() => (
      <IconTile testId="tile">
        <svg data-testid="glyph" />
      </IconTile>
    ));

    // Then
    const tile = byTestId('tile');
    expect(tile.getAttribute('aria-hidden')).toBe('true');
    expect(byTestId('glyph', tile, SVGElement).tagName.toLowerCase()).toBe('svg');
  });
});
