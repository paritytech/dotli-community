// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi, type Mock } from 'vitest';
import { bindCaptureSink } from '@dotli/metrics';
import { createReloadOffer, type ShowNotification } from '@dotli/ui';
import { getPageStandIns, reportIslandErrors } from './reportIslandErrors.js';

type Notice = Parameters<ShowNotification>[0];

/** An `astro-island` as the report reads it. */
type FakeIsland = EventTarget & { getAttribute: (name: string) => string | null };

/** The page the report listens on, and where its failures go. */
type ReportingPage = {
  captures: { exception: Mock };
  page: EventTarget;
  notices: Notice[];
  reload: Mock;
};

type Params = {
  /** What stands in for each island by name when its code never ran, none by default. */
  standIns?: Readonly<Record<string, () => void>>;
};

describe('island failures', () => {
  it('As an operator, I see the code of an island fail and it is reported once, by name, in place of the console log', () => {
    // Given
    const { captures, page } = setupReporting();

    // When
    const event = failHydration(page, createIsland('ChatDock'));

    // Then
    expect(event.defaultPrevented).toBe(true);
    expect(captures.exception).toHaveBeenCalledTimes(1);
    expect(captures.exception).toHaveBeenCalledWith(expect.any(Error), {
      flow: 'ui',
      step: 'island_hydration',
      tags: { root: 'island:ChatDock', kind: 'island_hydration_error' },
    });
  });

  it('As a visitor, I hit an island whose code failed and am offered a reload once, so a dead control is never a dead end', () => {
    // Given
    const { page, notices, reload } = setupReporting();

    // When
    failHydration(page, createIsland('LoadingScreen'));
    notices[0]?.action?.onClick();

    // Then
    expect(notices).toMatchObject([
      { label: 'Asset failed to load', tone: 'err', dismissMs: 0, action: { label: 'Reload' } },
    ]);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('As an operator, I see a failure from something that is not an island and it is reported as unknown', () => {
    // Given
    const { captures, page } = setupReporting();

    // When
    failHydration(page, null);

    // Then
    expect(captures.exception).toHaveBeenCalledWith(expect.any(Error), {
      flow: 'ui',
      step: 'island_hydration',
      tags: { root: 'island:unknown', kind: 'island_hydration_error' },
    });
  });

  it('As an operator, I stop the report and a later failure is no longer reported or offered a reload', () => {
    // Given
    const captures = { exception: vi.fn(), expected: vi.fn() };
    onTestFinished(bindCaptureSink(captures));
    const page = new EventTarget();
    const notify = vi.fn();
    const stop = reportIslandErrors({ target: page, offerReload: notify });

    // When
    stop();
    failHydration(page, createIsland('ChatDock'));

    // Then
    expect(captures.exception).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('As a visitor, I hit an island whose code never ran and it still does its part through its stand-in', () => {
    // Given
    const standIn = vi.fn();
    const { page } = setupReporting({ standIns: { AuthModal: standIn } });

    // When
    failHydration(page, createIsland('AuthModal'));

    // Then
    expect(standIn).toHaveBeenCalledOnce();
  });

  it('As a visitor, I hit an island with no stand-in and it is only reported', () => {
    // Given
    const standIn = vi.fn();
    const { captures, page } = setupReporting({ standIns: { AuthModal: standIn } });

    // When
    failHydration(page, createIsland('TopbarReveal'));

    // Then
    expect(standIn).not.toHaveBeenCalled();
    expect(captures.exception).toHaveBeenCalledOnce();
  });

  it('As a visitor, I hit an auth modal that never ran and the sign-in lease is released', () => {
    // Given
    const disableAuthModal = vi.fn();
    const { page } = setupReporting({ standIns: getPageStandIns({ disableAuthModal, refuseModals: vi.fn() }) });

    // When
    failHydration(page, createIsland('AuthModal'));

    // Then
    expect(disableAuthModal).toHaveBeenCalledOnce();
  });

  it('As a product developer, I prompt while the overlays never ran and my prompts are refused rather than left waiting', () => {
    // Given
    const refuseModals = vi.fn();
    const { page } = setupReporting({ standIns: getPageStandIns({ disableAuthModal: vi.fn(), refuseModals }) });

    // When
    failHydration(page, createIsland('Overlays'));

    // Then
    expect(refuseModals).toHaveBeenCalledOnce();
  });
});

function createIsland(component: string): FakeIsland {
  return Object.assign(new EventTarget(), {
    getAttribute: (name: string) => (name === 'component-export' ? component : null),
  });
}

/** Dispatches Astro's event for `island`, whose module or hydration failed, as it reaches the page, and returns it. */
function failHydration(page: EventTarget, island: FakeIsland | null): Event {
  const event = new CustomEvent('astro:hydration-error', {
    bubbles: true,
    cancelable: true,
    detail: { error: new Error('chunk failed'), componentUrl: null },
  });
  // Node has no tree to bubble through, so the target is set.
  Object.defineProperty(event, 'target', { value: island });
  page.dispatchEvent(event);
  return event;
}

/** Starts the report on a page of its own, with recording sinks, until the case ends. */
function setupReporting({ standIns = {} }: Params = {}): ReportingPage {
  const captures = { exception: vi.fn(), expected: vi.fn() };
  onTestFinished(bindCaptureSink(captures));
  const page = new EventTarget();
  const notices: Notice[] = [];
  const reload = vi.fn();
  onTestFinished(
    reportIslandErrors({
      target: page,
      offerReload: createReloadOffer({ notify: notice => notices.push(notice), reload }),
      standIns,
    }),
  );
  return { captures, page, notices, reload };
}
