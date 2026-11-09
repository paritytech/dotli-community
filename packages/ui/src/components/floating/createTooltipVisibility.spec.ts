// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createManualTimers } from '@dotli/shared/testing';
import { describe, expect, it } from 'vitest';
import { createTooltipVisibility, TOOLTIP_HIDE_MS, TOOLTIP_SHOW_MS } from './createTooltipVisibility.js';

describe('createTooltipVisibility', () => {
  it('As a mouse user, I rest on the trigger and the tooltip shows after the delay', async () => {
    // Given a hidden tooltip
    const { timers, opens, visibility } = setup();

    // When the mouse rests on the trigger through the delay
    visibility.rest();
    await timers.advance(TOOLTIP_SHOW_MS - 1);
    const opensBeforeDelay = [...opens];
    await timers.advance(1);

    // Then it shows only once the delay is over
    expect(opensBeforeDelay).toEqual([]);
    expect(opens).toEqual([true]);
    expect(visibility.isOpen()).toBe(true);
  });

  it('As a keyboard user whose tooltip shows, I press Escape as the mouse arrives and it stays hidden', async () => {
    // Given a tooltip that keyboard focus showed, with the mouse arriving on its trigger
    const { timers, opens, visibility } = setup();
    visibility.show();
    visibility.rest();

    // When Escape hides it and the show delay passes
    visibility.hide();
    await timers.advance(TOOLTIP_SHOW_MS);

    // Then it stays hidden
    expect(opens).toEqual([true, false]);
    expect(visibility.isOpen()).toBe(false);
  });

  it('As a mouse user, I press the trigger within the delay and the tooltip never shows', async () => {
    // Given a mouse resting on the trigger
    const { timers, opens, visibility } = setup();
    visibility.rest();

    // When the trigger is pressed within the delay and the delay passes
    visibility.cancelShow();
    await timers.advance(TOOLTIP_SHOW_MS);

    // Then it never shows and holds no timer
    expect(opens).toEqual([]);
    expect(timers.countPending()).toBe(0);
  });

  it('As a mouse user, the window loses focus within the delay and the tooltip never shows', async () => {
    // Given a mouse resting on the trigger
    const { timers, opens, visibility } = setup();
    visibility.rest();

    // When the window's blur hides it within the delay and the delay passes
    visibility.hide();
    await timers.advance(TOOLTIP_SHOW_MS);

    // Then it never shows and holds no timer
    expect(opens).toEqual([]);
    expect(timers.countPending()).toBe(0);
  });

  it('As a mouse user, I leave the trigger within the delay and the tooltip never shows', async () => {
    // Given a mouse resting on the trigger
    const { timers, opens, visibility } = setup();
    visibility.rest();

    // When the mouse leaves it within the delay and the delay passes
    visibility.leave();
    await timers.advance(TOOLTIP_SHOW_MS);

    // Then it never shows and holds no timer
    expect(opens).toEqual([]);
    expect(timers.countPending()).toBe(0);
  });

  it('As a mouse user, I leave the tooltip and it hides after the grace', async () => {
    // Given a shown tooltip
    const { timers, opens, visibility } = setup();
    visibility.show();

    // When the mouse leaves it and the grace runs out
    visibility.leave();
    await timers.advance(TOOLTIP_HIDE_MS - 1);
    const openWithinGrace = visibility.isOpen();
    await timers.advance(1);

    // Then it stays through the grace and hides after it
    expect(openWithinGrace).toBe(true);
    expect(opens).toEqual([true, false]);
  });

  it('As a mouse user, I move onto the tooltip within the grace and it stays', async () => {
    // Given a shown tooltip the mouse just left
    const { timers, opens, visibility } = setup();
    visibility.show();
    visibility.leave();

    // When the mouse moves onto the tooltip within the grace and the grace passes
    visibility.hold();
    await timers.advance(TOOLTIP_HIDE_MS);

    // Then it stays shown
    expect(opens).toEqual([true]);
    expect(visibility.isOpen()).toBe(true);
  });

  it('As a tooltip whose component is gone, I hear nothing more', async () => {
    // Given a mouse resting on the trigger
    const { timers, opens, visibility } = setup();
    visibility.rest();

    // When the component goes, the delay passes and focus asks it to show
    visibility.dispose();
    await timers.advance(TOOLTIP_SHOW_MS);
    visibility.show();

    // Then it never shows and holds no timer
    expect(opens).toEqual([]);
    expect(visibility.isOpen()).toBe(false);
    expect(timers.countPending()).toBe(0);
  });
});

function setup() {
  const timers = createManualTimers();
  const opens: boolean[] = [];
  const visibility = createTooltipVisibility({ onChange: open => opens.push(open), timers });
  return { timers, opens, visibility };
}
