// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { describeNetworkStatus } from '../../../src/components/shell/chains-format.js';

describe('describeNetworkStatus', () => {
  it('As a user with a good connection, the menu says so in one line', () => {
    // When
    const line = describeNetworkStatus({ text: 'Your connection is good', tone: 'ok' }, false);

    // Then
    expect(line).toEqual({ tone: 'ok', title: 'Your connection is good', detail: null });
  });

  it('As a user while the chains connect, the menu says it is syncing and how far it got', () => {
    // When
    const line = describeNetworkStatus({ text: 'Connecting, 2 of 3 ready', tone: 'idle' }, false);

    // Then
    expect(line).toEqual({ tone: 'idle', title: 'Syncing', detail: 'Connecting, 2 of 3 ready' });
  });

  it('As a user with a stalled chain, the menu says the connection is unstable and which chain it waits on', () => {
    // When
    const line = describeNetworkStatus({ text: 'Waiting on Asset Hub', tone: 'warn' }, false);

    // Then
    expect(line).toEqual({ tone: 'warn', title: 'Connection is unstable', detail: 'Waiting on Asset Hub' });
  });

  it('As a user who went offline, the menu says so whatever the chains last reported', () => {
    // When
    const line = describeNetworkStatus({ text: 'Your connection is good', tone: 'ok' }, true);

    // Then
    expect(line).toEqual({ tone: 'err', title: 'You are offline', detail: null });
  });
});
