// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A journey strings a tab's page loads at one app together until one reaches it, so Sentry can tell a recovered
// failure from an abandoned one. The id lives in sessionStorage only, so it never identifies a person.

import { takeContinuation, type Continuation } from '@dotli/shared';

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

export function beginAttempt(label: string): Attempt {
  const entry = takeContinuation() ?? navigationEntry();
  const stored = readJourney();
  const journey: StoredJourney =
    stored?.label === label ? { ...stored, attempts: stored.attempts + 1 } : { id: newJourneyId(), label, attempts: 1 };
  writeJourney(journey);
  return { journeyId: journey.id, attemptNumber: journey.attempts, entry };
}

/** The visitor reached the app, or learned there is nothing to reach. */
export function endJourney(): void {
  try {
    sessionStorage.removeItem(KEY);
    // eslint-disable-next-line no-restricted-syntax -- sessionStorage may be unavailable in Safari private mode, where nothing was stored.
  } catch {
    /* sessionStorage unavailable */
  }
}
