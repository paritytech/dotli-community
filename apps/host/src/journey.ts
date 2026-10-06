// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The attempts one visitor makes at opening one app, counted as a journey.
//
// Every page load is one attempt with its own resolution id. A journey strings
// together the attempts of a tab until one of them reaches the app, so Sentry
// can tell a failure the visitor recovered from (a reload, a transport switch)
// from one they gave up on, instead of counting each retry as a new visitor.
//
// The id is random and lives in this tab's sessionStorage only: it dies with
// the tab and never links two sessions, so it identifies a journey and not a
// person. Each app is its own origin, so a journey never spans two apps. A
// network change wipes this origin's sessionStorage (`wipeOriginState`), and
// with it the journey: on another network it is a different app.

import { takeContinuation, type Continuation } from '@dotli/shared';

/**
 * How this attempt began. The app's own reloads say why they reloaded (see
 * `markContinuation`). Anything else is read from the navigation itself, which
 * cannot tell a typed URL from a followed link.
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

const KEY = 'dotli:journey';

function readJourney(): StoredJourney | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw === null) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<StoredJourney>;
    if (typeof parsed.id !== 'string' || typeof parsed.label !== 'string' || typeof parsed.attempts !== 'number') {
      return null;
    }
    return { id: parsed.id, label: parsed.label, attempts: parsed.attempts };
  } catch {
    // Unavailable sessionStorage or a corrupt entry both mean no journey to continue.
    return null;
  }
}

function writeJourney(journey: StoredJourney): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(journey));
    // eslint-disable-next-line no-restricted-syntax -- sessionStorage may be unavailable in Safari private mode, where every attempt starts its own journey.
  } catch {
    /* sessionStorage unavailable */
  }
}

function navigationEntry(): AttemptEntry {
  const [entry] = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
  if (entry?.type === 'reload') {
    return 'browser_reload';
  }
  return entry?.type === 'back_forward' ? 'back_forward' : 'navigation';
}

function newJourneyId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `journey-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`;
}

/** Count this page load as the next attempt of the tab's journey for `label`. */
export function beginAttempt(label: string): Attempt {
  const entry = takeContinuation() ?? navigationEntry();
  const stored = readJourney();
  const journey: StoredJourney =
    stored?.label === label ? { ...stored, attempts: stored.attempts + 1 } : { id: newJourneyId(), label, attempts: 1 };
  writeJourney(journey);
  return { journeyId: journey.id, attemptNumber: journey.attempts, entry };
}

/**
 * Close the journey: the visitor reached the app, or learned there is nothing
 * to reach. The next load starts a new one.
 */
export function endJourney(): void {
  try {
    sessionStorage.removeItem(KEY);
    // eslint-disable-next-line no-restricted-syntax -- sessionStorage may be unavailable in Safari private mode, where nothing was stored.
  } catch {
    /* sessionStorage unavailable */
  }
}
