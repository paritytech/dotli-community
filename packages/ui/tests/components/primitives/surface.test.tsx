// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { Hint, Surface, SurfaceFoot, SurfaceHead } from '../../../src/components/primitives/Surface.js';
import { InSheet } from '../../../src/components/sheet/in-sheet.js';
import { renderComponent } from '../../helpers/solid.js';
import { byTestId } from '../../support.js';

describe('Surface', () => {
  it('As a user, I read a popover with its title, its body and its footer', () => {
    // Given / When
    renderComponent(() => (
      <Surface label="Permissions" testId="surface">
        <SurfaceHead title="Permissions" aside={<span>host-playground.paseo</span>} testId="head" />
        <p>Rows</p>
        <SurfaceFoot hint={<Hint>Changes reload the app</Hint>} testId="foot">
          <button type="button">Reset all to Ask</button>
        </SurfaceFoot>
      </Surface>
    ));

    // Then
    const surface = byTestId('surface');
    expect(surface.tagName).toBe('SECTION');
    expect(surface.getAttribute('aria-label')).toBe('Permissions');
    expect(byTestId('head').querySelector('h2')?.textContent).toBe('Permissions');
    expect(byTestId('foot').textContent).toBe('Changes reload the appReset all to Ask');
  });

  it('As an assistive technology user in a bottom sheet, I hear the title once, from the sheet', () => {
    // Given / When
    renderComponent(() => (
      <InSheet value={() => true}>
        <Surface label="Permissions" testId="surface">
          <SurfaceHead title="Permissions" testId="head" />
          <p>Rows</p>
        </Surface>
      </InSheet>
    ));

    // Then
    expect(byTestId('surface').querySelector('[data-testid="head"]')).toBeNull();
    expect(byTestId('surface').textContent).toBe('Rows');
  });
});
