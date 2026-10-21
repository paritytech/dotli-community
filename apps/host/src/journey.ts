// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A journey strings a tab's page loads at one app together until one reaches it, so Sentry can tell a recovered
// failure from an abandoned one. The id lives in sessionStorage only, so it never identifies a person.

import { pageSessionStorage, randomId, type SafeStorage } from '@dotli/shared';
import { takeContinuation, type Continuation } from './continuation.js';

/**
 * The app's own reloads say why (`markContinuation`). Others come from the navigation, which cannot tell a typed URL
 * from a followed link.
 */
export type AttemptEntry = Continuation | 'browser_reload' | 'back_forward' | 'navigation';

export interface Attempt {
  journeyId: string;
  /** 1 for the first attempt of the journey. */
  attemptNumber: number;
  entry: AttemptEntry;
}

interface StoredJourney {
  id: string;
  label: string;
  attempts: number;
}

/** The page's session storage, navigation timing and reload reason, in place of the browser's own in a spec. */
export interface JourneyDeps {
  /** This tab's sessionStorage, which never throws. */
  session: Pick<SafeStorage, 'getItem' | 'setItem' | 'removeItem'>;
  navigationType: () => NavigationTimingType | undefined;
  takeContinuation: () => Continuation | null;
}

const pageJourney: JourneyDeps = {
  session: pageSessionStorage,
  navigationType: () => (performance.getEntriesByType('navigation') as PerformanceNavigationTiming[])[0]?.type,
  takeContinuation,
};

const KEY = 'dotli:journey';

function readJourney(deps: JourneyDeps): StoredJourney | null {
  const raw = deps.session.getItem(KEY);
  if (raw === null) {
    return null;
  }
  let parsed: Partial<StoredJourney>;
  try {
    parsed = JSON.parse(raw) as Partial<StoredJourney>;
  } catch {
    // A corrupt entry means no journey to continue.
    return null;
  }
  if (typeof parsed.id !== 'string' || typeof parsed.label !== 'string' || typeof parsed.attempts !== 'number') {
    return null;
  }
  return { id: parsed.id, label: parsed.label, attempts: parsed.attempts };
}

function writeJourney(deps: JourneyDeps, journey: StoredJourney): void {
  deps.session.setItem(KEY, JSON.stringify(journey));
}

function navigationEntry(deps: JourneyDeps): AttemptEntry {
  const type = deps.navigationType();
  if (type === 'reload') {
    return 'browser_reload';
  }
  return type === 'back_forward' ? 'back_forward' : 'navigation';
}

export function beginAttempt(label: string, deps: JourneyDeps = pageJourney): Attempt {
  const entry = deps.takeContinuation() ?? navigationEntry(deps);
  const stored = readJourney(deps);
  const journey: StoredJourney =
    stored?.label === label ? { ...stored, attempts: stored.attempts + 1 } : { id: randomId(), label, attempts: 1 };
  writeJourney(deps, journey);
  return { journeyId: journey.id, attemptNumber: journey.attempts, entry };
}

/** The visitor reached the app, or learned there is nothing to reach. */
export function endJourney(deps: JourneyDeps = pageJourney): void {
  deps.session.removeItem(KEY);
}
