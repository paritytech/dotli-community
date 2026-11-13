// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A journey strings a tab's page loads at one app together until one reaches it, so Sentry can tell a recovered
// failure from an abandoned one. The id lives in sessionStorage only, so it never identifies a person.

import { pageSessionStorage, createRandomId, isRecord, type SafeStorage } from '@dotli/shared';
import { continuation, type Continuation } from './createContinuation.js';

/**
 * The app's own reloads say why. Others come from the navigation, which cannot tell a typed URL from a followed link.
 */
export type AttemptEntry = Continuation | 'browser_reload' | 'back_forward' | 'navigation';

export type Attempt = {
  journeyId: string;
  /** 1 for the first attempt of the journey. */
  attemptNumber: number;
  entry: AttemptEntry;
};

type StoredJourney = {
  id: string;
  label: string;
  attempts: number;
};

/** The page's session storage, navigation timing and reload reason, in place of the browser's own in a spec. */
export type JourneyParams = {
  /** This tab's sessionStorage, which never throws. */
  session: Pick<SafeStorage, 'getItem' | 'setItem' | 'removeItem'>;
  /** Returns how this page load was navigated to, or undefined where the browser does not say. Never throws. */
  navigationType: () => NavigationTimingType | undefined;
  /** Returns the reason the app gave for this reload and clears it, or null when it gave none. Never throws. */
  takeContinuation: () => Continuation | null;
};

const pageJourney: JourneyParams = {
  session: pageSessionStorage,
  navigationType: readNavigationType,
  takeContinuation: continuation.take,
};

const KEY = 'dotli:journey';

/**
 * Starts a page load's attempt at `label`, continuing the tab's journey when its last attempt was at the same label, and
 * returns it. Throws only as `params` do.
 */
export function beginAttempt(label: string, params: JourneyParams = pageJourney): Attempt {
  const entry = params.takeContinuation() ?? getNavigationEntry(params.navigationType());
  const stored = readJourney(params.session);
  const journey: StoredJourney =
    stored?.label === label
      ? { ...stored, attempts: stored.attempts + 1 }
      : { id: createRandomId(), label, attempts: 1 };
  params.session.setItem(KEY, JSON.stringify(journey));
  return { journeyId: journey.id, attemptNumber: journey.attempts, entry };
}

/** Ends the tab's journey: the visitor reached the app, or learned there is nothing to reach. Never throws. */
export function endJourney(params: JourneyParams = pageJourney): void {
  params.session.removeItem(KEY);
}

function readJourney(session: JourneyParams['session']): StoredJourney | null {
  const raw = session.getItem(KEY);
  if (raw === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A corrupt entry means no journey to continue.
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  const { id, label, attempts } = parsed;
  if (typeof id !== 'string' || typeof label !== 'string' || typeof attempts !== 'number') {
    return null;
  }
  return { id, label, attempts };
}

function getNavigationEntry(type: NavigationTimingType | undefined): AttemptEntry {
  // Not a `switch`: a browser may report a type the DOM types leave out, such as `prerender`, which is a navigation.
  if (type === 'reload') {
    return 'browser_reload';
  }
  return type === 'back_forward' ? 'back_forward' : 'navigation';
}

function readNavigationType(): NavigationTimingType | undefined {
  const [entry] = performance.getEntriesByType('navigation');
  // A runtime with no navigation entry may not define the class either.
  if (entry === undefined) {
    return undefined;
  }
  return entry instanceof PerformanceNavigationTiming ? entry.type : undefined;
}
