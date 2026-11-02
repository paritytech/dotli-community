// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createMemoryStorage } from '@dotli/shared/testing';
import { createContinuation } from './createContinuation.js';

import { beginAttempt, endJourney, type Attempt } from './journey.js';

/** One tab: its session storage, which also keeps why the app reloaded it, and how it was last navigated. */
type Tab = {
  session: Storage;
  /** Sets how the tab's next load was navigated to. */
  setNavigationType: (type: NavigationTimingType) => void;
  /** Begins an attempt at opening `label` in this tab. */
  beginAttempt: (label: string) => Attempt;
  /** Ends this tab's journey. */
  endJourney: () => void;
};

describe('Attempts at opening an app form a journey', () => {
  it('As a maintainer, I see a first visit and it starts a journey at attempt one', () => {
    // Given
    const tab = setupTab();
    tab.setNavigationType('navigate');

    // When
    const attempt = tab.beginAttempt('coffer');

    // Then
    expect(attempt).toMatchObject({ attemptNumber: 1, entry: 'navigation' });
    expect(attempt.journeyId).not.toBe('');
  });

  it('As a maintainer, I see a browser reload after a failure and it continues the same journey', () => {
    // Given
    const tab = setupTab();
    tab.setNavigationType('navigate');
    const first = tab.beginAttempt('coffer');

    // When
    tab.setNavigationType('reload');
    const second = tab.beginAttempt('coffer');

    // Then
    expect(second).toEqual({ journeyId: first.journeyId, attemptNumber: 2, entry: 'browser_reload' });
  });

  it('As a maintainer, I see a transport switch reload the page and it is told apart from a plain reload', () => {
    // Given
    const tab = setupTab();
    tab.setNavigationType('navigate');
    const first = tab.beginAttempt('coffer');
    createContinuation({ store: tab.session }).mark('switch_backend');

    // When the switch reloads the page
    tab.setNavigationType('reload');
    const second = tab.beginAttempt('coffer');

    // Then
    expect(second).toEqual({ journeyId: first.journeyId, attemptNumber: 2, entry: 'switch_backend' });
  });

  it('As a maintainer, I see a second reload and the reason given for the first describes only the load right after it', () => {
    // Given
    const tab = setupTab();
    createContinuation({ store: tab.session }).mark('reload_button');
    tab.setNavigationType('reload');
    tab.beginAttempt('coffer');

    // When the visitor reloads again with the browser
    const third = tab.beginAttempt('coffer');

    // Then
    expect(third.entry).toBe('browser_reload');
  });

  it('As a maintainer, I see the app reached and the journey ends, so the next visit starts a new one', () => {
    // Given
    const tab = setupTab();
    tab.setNavigationType('navigate');
    const first = tab.beginAttempt('coffer');

    // When
    tab.endJourney();
    const next = tab.beginAttempt('coffer');

    // Then
    expect(next.attemptNumber).toBe(1);
    expect(next.journeyId).not.toBe(first.journeyId);
  });

  it('As a maintainer, I see a visit to another app and the journey does not carry over', () => {
    // Given
    const tab = setupTab();
    tab.setNavigationType('navigate');
    const first = tab.beginAttempt('coffer');

    // When
    const other = tab.beginAttempt('shaderlab');

    // Then
    expect(other.attemptNumber).toBe(1);
    expect(other.journeyId).not.toBe(first.journeyId);
  });

  it('As a maintainer, I see a corrupt journey entry and a fresh journey starts instead of the load failing', () => {
    // Given
    const tab = setupTab();
    tab.session.setItem('dotli:journey', '{not json');
    tab.setNavigationType('navigate');

    // When
    const attempt = tab.beginAttempt('coffer');

    // Then
    expect(attempt.attemptNumber).toBe(1);
  });
});

/** Builds a fresh tab, first navigated to. */
function setupTab(): Tab {
  const session = createMemoryStorage();
  let navigation: NavigationTimingType = 'navigate';
  const params = {
    session,
    navigationType: () => navigation,
    takeContinuation: () => createContinuation({ store: session }).take(),
  };
  return {
    session,
    setNavigationType(type) {
      navigation = type;
    },
    beginAttempt: label => beginAttempt(label, params),
    endJourney() {
      endJourney(params);
    },
  };
}
