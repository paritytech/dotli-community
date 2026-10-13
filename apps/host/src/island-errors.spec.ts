// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { bindCaptureSink } from '@dotli/metrics';
import type { ShowNotification } from '@dotli/ui';
import { pageStandIns, reportIslandErrors } from './island-errors.js';

type Notice = Parameters<ShowNotification>[0];

/** An `astro-island` as the report reads it. */
class FakeIsland extends EventTarget {
  private readonly component: string;

  constructor(component: string) {
    super();
    this.component = component;
  }

  getAttribute(name: string): string | null {
    return name === 'component-export' ? this.component : null;
  }
}

/** Astro's event for `island`, whose module or hydration failed, as it reaches the page. */
function failOn(page: EventTarget, island: FakeIsland | null): Event {
  const ev = new CustomEvent('astro:hydration-error', {
    bubbles: true,
    cancelable: true,
    detail: { error: new Error('chunk failed'), componentUrl: null },
  });
  // Node has no tree to bubble through, so the target is set.
  Object.defineProperty(ev, 'target', { value: island });
  page.dispatchEvent(ev);
  return ev;
}

function setup(standIns: Readonly<Record<string, () => void>> = {}): {
  captures: { exception: ReturnType<typeof vi.fn> };
  page: EventTarget;
  notices: Notice[];
  reload: ReturnType<typeof vi.fn>;
} {
  const captures = { exception: vi.fn(), expected: vi.fn() };
  onTestFinished(bindCaptureSink(captures));
  const page = new EventTarget();
  const notices: Notice[] = [];
  const reload = vi.fn();
  onTestFinished(reportIslandErrors({ target: page, notify: notice => notices.push(notice), reload, standIns }));
  return { captures, page, notices, reload };
}

describe('island failures', () => {
  it('As the shell, an island whose code failed is reported once, by name, in place of the console log', () => {
    // Given
    const { captures, page } = setup();

    // When
    const ev = failOn(page, new FakeIsland('ChatDock'));

    // Then
    expect(ev.defaultPrevented).toBe(true);
    expect(captures.exception).toHaveBeenCalledTimes(1);
    expect(captures.exception).toHaveBeenCalledWith(expect.any(Error), {
      flow: 'ui',
      step: 'island_hydration',
      tags: { root: 'island:ChatDock', kind: 'island_hydration_error' },
    });
  });

  it('As a visitor, an island whose code failed offers a reload once, so a dead control is never a dead end', () => {
    // Given
    const { page, notices, reload } = setup();

    // When
    failOn(page, new FakeIsland('LoadingScreen'));
    notices[0]?.action?.onClick();

    // Then
    expect(notices).toMatchObject([
      { label: 'Asset failed to load', tone: 'err', dismissMs: 0, action: { label: 'Reload' } },
    ]);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('As the shell, a failure from something that is not an island is reported as unknown', () => {
    // Given
    const { captures, page } = setup();

    // When
    failOn(page, null);

    // Then
    expect(captures.exception).toHaveBeenCalledWith(expect.any(Error), {
      flow: 'ui',
      step: 'island_hydration',
      tags: { root: 'island:unknown', kind: 'island_hydration_error' },
    });
  });

  it('As the shell, after the stop a failure is no longer reported or offered a reload', () => {
    // Given
    const captures = { exception: vi.fn(), expected: vi.fn() };
    onTestFinished(bindCaptureSink(captures));
    const page = new EventTarget();
    const notify = vi.fn();
    const stop = reportIslandErrors({ target: page, notify, reload: vi.fn() });

    // When
    stop();
    failOn(page, new FakeIsland('ChatDock'));

    // Then
    expect(captures.exception).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('As a visitor, an island whose code never ran still does its part through its stand-in', () => {
    // Given
    const standIn = vi.fn();
    const { page } = setup({ AuthModal: standIn });

    // When
    failOn(page, new FakeIsland('AuthModal'));

    // Then
    expect(standIn).toHaveBeenCalledOnce();
  });

  it('As a visitor, an island with no stand-in is only reported', () => {
    // Given
    const standIn = vi.fn();
    const { captures, page } = setup({ AuthModal: standIn });

    // When
    failOn(page, new FakeIsland('TopbarReveal'));

    // Then
    expect(standIn).not.toHaveBeenCalled();
    expect(captures.exception).toHaveBeenCalledOnce();
  });

  it('As a visitor, an auth modal that never ran releases the sign-in lease', () => {
    // Given
    const disableAuthModal = vi.fn();
    const { page } = setup(pageStandIns({ disableAuthModal, refuseModals: vi.fn() }));

    // When
    failOn(page, new FakeIsland('AuthModal'));

    // Then
    expect(disableAuthModal).toHaveBeenCalledOnce();
  });

  it('As a product, overlays that never ran refuse my prompts rather than leave them waiting', () => {
    // Given
    const refuseModals = vi.fn();
    const { page } = setup(pageStandIns({ disableAuthModal: vi.fn(), refuseModals }));

    // When
    failOn(page, new FakeIsland('Overlays'));

    // Then
    expect(refuseModals).toHaveBeenCalledOnce();
  });
});
