// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { describeNetworkStatus, type LiveVerdict } from '../../../src/components/shell/chains-format.js';

describe('describeNetworkStatus', () => {
  it('As a user with a good connection, the menu says so in one line', () => {
    // Given
    const health: LiveVerdict = { text: 'Your connection is good', tone: 'ok' };

    // When
    const line = describeNetworkStatus(health, false);

    // Then
    expect(line).toEqual({ tone: 'ok', title: 'Your connection is good', detail: null });
  });

  it('As a user while the chains connect, the menu says it is syncing and how far it got', () => {
    // Given
    const health: LiveVerdict = { text: 'Connecting, 2 of 3 ready', tone: 'idle' };

    // When
    const line = describeNetworkStatus(health, false);

    // Then
    expect(line).toEqual({ tone: 'idle', title: 'Syncing', detail: 'Connecting, 2 of 3 ready' });
  });

  it('As a user with a stalled chain, the menu says the connection is unstable and which chain it waits on', () => {
    // Given
    const health: LiveVerdict = { text: 'Waiting on Asset Hub', tone: 'warn' };

    // When
    const line = describeNetworkStatus(health, false);

    // Then
    expect(line).toEqual({ tone: 'warn', title: 'Connection is unstable', detail: 'Waiting on Asset Hub' });
  });

  it('As a user who went offline, the menu says so whatever the chains last reported', () => {
    // Given
    const health: LiveVerdict = { text: 'Your connection is good', tone: 'ok' };

    // When
    const line = describeNetworkStatus(health, true);

    // Then
    expect(line).toEqual({ tone: 'err', title: 'You are offline', detail: null });
  });
});
