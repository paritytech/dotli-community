// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// An island that fails to load or hydrate keeps its build-time markup, and what it would have done is stood in for.

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { bindCaptureSink } from '@dotli/metrics';
import { createSyncStore } from '@dotli/shared';
import { reportIslandErrors, type IslandStandIns } from './island-errors.js';

/** An `astro-island` as the stand-ins see it. */
class FakeIsland extends EventTarget {
  cleared = false;
  private readonly component: string;

  constructor(component: string) {
    super();
    this.component = component;
  }

  getAttribute(name: string): string | null {
    return name === 'component-export' ? this.component : null;
  }

  replaceChildren(): void {
    this.cleared = true;
  }
}

/** Astro's event for an island whose module or hydration failed. */
function failure(): Event {
  return new CustomEvent('astro:hydration-error', {
    bubbles: true,
    cancelable: true,
    detail: { error: new Error('chunk failed'), componentUrl: null },
  });
}

function setup(early: readonly Event[] = []) {
  const captures = { exception: vi.fn(), expected: vi.fn() };
  onTestFinished(bindCaptureSink(captures));
  const page = new EventTarget();
  const loading = createSyncStore<{ phase: 'active' | 'gone' }>('loading-spec', { phase: 'active' });
  const standIns = { disableAuthModal: vi.fn(), showBrokenPage: vi.fn() } satisfies IslandStandIns;
  onTestFinished(
    reportIslandErrors({
      target: page,
      early,
      loading: { store: loading, gone: state => state.phase === 'gone' },
      standIns,
    }),
  );
  return { captures, page, loading, standIns };
}

/** A failure on `island` as it reaches the document. Node has no tree to bubble through, so the target is set. */
function failureOf(island: FakeIsland): Event {
  const ev = failure();
  Object.defineProperty(ev, 'target', { value: island });
  return ev;
}

function failOn(page: EventTarget, island: FakeIsland): Event {
  const ev = failureOf(island);
  page.dispatchEvent(ev);
  return ev;
}

describe('island failures', () => {
  it('As the shell, a failed island is reported once, by name', () => {
    // Given
    const { captures, page } = setup();

    // When
    const ev = failOn(page, new FakeIsland('ChatDock'));

    // Then
    expect(captures.exception).toHaveBeenCalledTimes(1);
    expect(captures.exception).toHaveBeenCalledWith(expect.any(Error), {
      flow: 'ui',
      step: 'island_hydration',
      tags: { root: 'island:ChatDock', kind: 'island_hydration_error' },
    });
    expect(ev.defaultPrevented).toBe(true);
  });

  it('As a visitor, a loading screen that never hydrated goes when loading ends', () => {
    // Given
    const { page, loading } = setup();
    const screen = new FakeIsland('LoadingScreen');
    failOn(page, screen);
    expect(screen.cleared).toBe(false);

    // When
    loading.set({ ...loading.get(), phase: 'gone' });

    // Then
    expect(screen.cleared).toBe(true);
  });

  it.each(['LandingAuth', 'LandingNav', 'LandingRecents'])(
    'As a visitor on the bare host, a landing page whose %s island never hydrated shows the reload error page',
    component => {
      // Given
      const { page, standIns } = setup();

      // When
      failOn(page, new FakeIsland(component));

      // Then
      expect(standIns.showBrokenPage).toHaveBeenCalledTimes(1);
    },
  );

  it('As a visitor, a login never waits on an AuthModal island that never hydrated', () => {
    // Given
    const { page, standIns } = setup();

    // When
    failOn(page, new FakeIsland('AuthModal'));

    // Then
    expect(standIns.disableAuthModal).toHaveBeenCalledTimes(1);
    expect(standIns.showBrokenPage).not.toHaveBeenCalled();
  });

  it('As the shell, an island that failed before the host listened is reported and stood in for, and later ones as they happen', () => {
    // Given: the host page's inline script kept a failure from before boot.
    const screen = new FakeIsland('LoadingScreen');
    const kept = failureOf(screen);

    // When
    const { captures, page, loading } = setup([kept]);

    // Then
    expect(captures.exception).toHaveBeenCalledTimes(1);
    expect(captures.exception).toHaveBeenCalledWith(expect.any(Error), {
      flow: 'ui',
      step: 'island_hydration',
      tags: { root: 'island:LoadingScreen', kind: 'island_hydration_error' },
    });
    loading.set({ ...loading.get(), phase: 'gone' });
    expect(screen.cleared).toBe(true);

    // When
    failOn(page, new FakeIsland('ChatDock'));

    // Then
    expect(captures.exception).toHaveBeenCalledTimes(2);
  });
});
