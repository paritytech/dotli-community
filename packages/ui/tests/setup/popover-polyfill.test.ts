// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';

describe('popover polyfill', () => {
  it('shows, hides and reports each change through beforetoggle and toggle', () => {
    const el = document.createElement('div');
    el.setAttribute('popover', 'auto');
    document.body.append(el);
    const seen: string[] = [];
    el.addEventListener('beforetoggle', ev => seen.push(`before:${ev.newState}`));
    el.addEventListener('toggle', ev => seen.push(`toggle:${ev.newState}`));

    el.showPopover();
    expect(el.hasAttribute('data-popover-open')).toBe(true);
    el.hidePopover();
    expect(el.hasAttribute('data-popover-open')).toBe(false);

    expect(seen).toEqual(['before:open', 'toggle:open', 'before:closed', 'toggle:closed']);
    el.remove();
  });

  it('togglePopover follows force', () => {
    const el = document.createElement('div');
    el.setAttribute('popover', 'manual');
    document.body.append(el);
    el.togglePopover(true);
    el.togglePopover(true);
    expect(el.hasAttribute('data-popover-open')).toBe(true);
    el.togglePopover();
    expect(el.hasAttribute('data-popover-open')).toBe(false);
    el.remove();
  });
});
