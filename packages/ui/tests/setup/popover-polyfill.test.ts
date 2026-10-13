// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';

describe('popover polyfill', () => {
  it('As a functional test under happy-dom, I show and hide a popover and hear each change through beforetoggle and toggle', () => {
    // Given
    const el = document.createElement('div');
    el.setAttribute('popover', 'auto');
    document.body.append(el);
    const seen: string[] = [];
    el.addEventListener('beforetoggle', ev => seen.push(`before:${ev.newState}`));
    el.addEventListener('toggle', ev => seen.push(`toggle:${ev.newState}`));

    // When
    el.showPopover();

    // Then
    expect(el.hasAttribute('data-popover-open')).toBe(true);

    // When
    el.hidePopover();

    // Then
    expect(el.hasAttribute('data-popover-open')).toBe(false);
    expect(seen).toEqual(['before:open', 'toggle:open', 'before:closed', 'toggle:closed']);
    el.remove();
  });

  it('As a functional test under happy-dom, I toggle a popover with and without force and it follows', () => {
    // Given
    const el = document.createElement('div');
    el.setAttribute('popover', 'manual');
    document.body.append(el);

    // When
    el.togglePopover(true);
    el.togglePopover(true);

    // Then
    expect(el.hasAttribute('data-popover-open')).toBe(true);

    // When
    el.togglePopover();

    // Then
    expect(el.hasAttribute('data-popover-open')).toBe(false);
    el.remove();
  });
});
