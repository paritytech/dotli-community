// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it } from 'vitest';
import { memoryStorage } from '@dotli/shared/testing';
import type { Continuation } from './continuation.js';

import { beginAttempt as beginOnPage, endJourney as endOnPage, type Attempt, type JourneyDeps } from './journey.js';

/** One tab: its session storage, how it was last navigated, and the reason the app gave for its own reload. */
let session: Storage;
let navigation: NavigationTimingType;
let continuation: Continuation | null;

const tab: JourneyDeps = {
  // The tab's storage is replaced for each test.
  get session() {
    return session;
  },
  navigationType: () => navigation,
  // Read once, as the page reads the reason its last reload left.
  takeContinuation: () => {
    const taken = continuation;
    continuation = null;
    return taken;
  },
};

function navigatedBy(type: NavigationTimingType): void {
  navigation = type;
}

function markContinuation(reason: Continuation): void {
  continuation = reason;
}

const beginAttempt = (label: string): Attempt => beginOnPage(label, tab);
const endJourney = (): void => {
  endOnPage(tab);
};

beforeEach(() => {
  session = memoryStorage();
  navigation = 'navigate';
  continuation = null;
});

describe('Attempts at opening an app form a journey', () => {
  it('As a maintainer, the first visit starts a journey at attempt one', () => {
    // Given
    navigatedBy('navigate');

    // When
    const attempt = beginAttempt('coffer');

    // Then
    expect(attempt).toMatchObject({ attemptNumber: 1, entry: 'navigation' });
    expect(attempt.journeyId).not.toBe('');
  });

  it('As a maintainer, a browser reload after a failure continues the same journey', () => {
    // Given
    navigatedBy('navigate');
    const first = beginAttempt('coffer');

    // When
    navigatedBy('reload');
    const second = beginAttempt('coffer');

    // Then
    expect(second).toEqual({ journeyId: first.journeyId, attemptNumber: 2, entry: 'browser_reload' });
  });

  it('As a maintainer, a transport switch is told apart from a plain reload', () => {
    // Given
    navigatedBy('navigate');
    const first = beginAttempt('coffer');
    markContinuation('switch_backend');

    // When the switch reloads the page
    navigatedBy('reload');
    const second = beginAttempt('coffer');

    // Then
    expect(second).toEqual({ journeyId: first.journeyId, attemptNumber: 2, entry: 'switch_backend' });
  });

  it('As a maintainer, the reason for a reload describes only the load right after it', () => {
    // Given
    markContinuation('reload_button');
    navigatedBy('reload');
    beginAttempt('coffer');

    // When the visitor reloads again with the browser
    const third = beginAttempt('coffer');

    // Then
    expect(third.entry).toBe('browser_reload');
  });

  it('As a maintainer, reaching the app ends the journey, so the next visit starts a new one', () => {
    // Given
    navigatedBy('navigate');
    const first = beginAttempt('coffer');

    // When
    endJourney();
    const next = beginAttempt('coffer');

    // Then
    expect(next.attemptNumber).toBe(1);
    expect(next.journeyId).not.toBe(first.journeyId);
  });

  it('As a maintainer, a journey never carries over to another app', () => {
    // Given
    navigatedBy('navigate');
    const first = beginAttempt('coffer');

    // When
    const other = beginAttempt('shaderlab');

    // Then
    expect(other.attemptNumber).toBe(1);
    expect(other.journeyId).not.toBe(first.journeyId);
  });

  it('As a maintainer, a corrupt journey entry starts a fresh journey instead of failing the load', () => {
    // Given
    session.setItem('dotli:journey', '{not json');
    navigatedBy('navigate');

    // When
    const attempt = beginAttempt('coffer');

    // Then
    expect(attempt.attemptNumber).toBe(1);
  });
});
