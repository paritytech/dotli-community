// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  describeNetworkStatus,
  HISTORY_SLOTS,
  slotOpacity,
  type LiveVerdict,
} from '../../../src/components/shell/chains-format.js';

describe('describeNetworkStatus under a light client', () => {
  it('As a user with a good connection, the caption counts the chains in sync', () => {
    // Given
    const health: LiveVerdict = { text: 'Your connection is good', tone: 'ok' };

    // When
    const line = describeNetworkStatus(health, false, 4, 'smoldot-direct');

    // Then
    expect(line).toEqual({
      tone: 'ok',
      title: 'Your connection is good',
      detail: 'Light client is in sync on all four chains',
    });
  });

  it('As a user with ten chains, the count is written in digits', () => {
    // Given
    const health: LiveVerdict = { text: 'Your connection is good', tone: 'ok' };

    // When
    const line = describeNetworkStatus(health, false, 10, 'smoldot-direct');

    // Then
    expect(line.detail).toBe('Light client is in sync on all 10 chains');
  });

  it('As a user while the chains connect, the caption says peers are being found', () => {
    // Given
    const health: LiveVerdict = { text: 'Connecting, 2 of 3 ready', tone: 'idle' };

    // When
    const line = describeNetworkStatus(health, false, 3, 'smoldot-direct');

    // Then
    expect(line).toEqual({ tone: 'idle', title: 'Syncing', detail: 'Finding peers. This takes a few seconds.' });
  });

  it('As a user with two stalled chains, the caption names them', () => {
    // Given
    const health: LiveVerdict = { text: 'Waiting on Hub and Identity', tone: 'warn', slow: ['Hub', 'Identity'] };

    // When
    const line = describeNetworkStatus(health, false, 4, 'smoldot-direct');

    // Then
    expect(line).toEqual({
      tone: 'warn',
      title: 'Connection is unstable',
      detail: 'Hub and Identity are behind',
    });
  });

  it('As a user with one stalled chain, the caption says "is"', () => {
    // Given
    const health: LiveVerdict = { text: 'Waiting on Hub', tone: 'warn', slow: ['Hub'] };

    // When
    const line = describeNetworkStatus(health, false, 4, 'smoldot-direct');

    // Then
    expect(line.detail).toBe('Hub is behind');
  });

  it('As a user who went offline, the menu says so whatever the chains last reported', () => {
    // Given
    const health: LiveVerdict = { text: 'Your connection is good', tone: 'ok' };

    // When
    const line = describeNetworkStatus(health, true, 4, 'smoldot-direct');

    // Then
    expect(line).toEqual({ tone: 'err', title: 'You are offline', detail: 'No peers on any chain. Retrying.' });
  });

  it('As a user with two chains, the caption says both rather than counting them', () => {
    // Given
    const health: LiveVerdict = { text: 'Your connection is good', tone: 'ok' };

    // When
    const line = describeNetworkStatus(health, false, 2, 'smoldot-direct');

    // Then
    expect(line.detail).toBe('Light client is in sync on both chains');
  });

  it("As a user on the shared-worker light client, the captions are the light client's", () => {
    // Given
    const health: LiveVerdict = { text: 'Waiting on Hub', tone: 'warn', slow: ['Hub'] };

    // When
    const line = describeNetworkStatus(health, false, 4, 'smoldot-shared-worker');

    // Then
    expect(line.detail).toBe('Hub is behind');
  });
});

describe('describeNetworkStatus under trusted providers', () => {
  it('As a user on trusted providers with a good connection, the caption claims no light client', () => {
    // Given
    const health: LiveVerdict = { text: 'Your connection is good', tone: 'ok' };

    // When
    const line = describeNetworkStatus(health, false, 4, 'rpc-gateway');

    // Then
    expect(line).toEqual({ tone: 'ok', title: 'Your connection is good', detail: 'Served by trusted providers' });
  });

  it('As a user on trusted providers while the chains connect, the caption speaks of providers, not peers', () => {
    // Given
    const health: LiveVerdict = { text: 'Connecting, 2 of 3 ready', tone: 'idle' };

    // When
    const line = describeNetworkStatus(health, false, 3, 'rpc-gateway');

    // Then
    expect(line).toEqual({
      tone: 'idle',
      title: 'Syncing',
      detail: 'Reaching trusted providers. This takes a few seconds.',
    });
  });

  it('As a user on trusted providers with stalled chains, the caption says they are behind', () => {
    // Given
    const health: LiveVerdict = { text: 'Waiting on Hub and Identity', tone: 'warn', slow: ['Hub', 'Identity'] };

    // When
    const line = describeNetworkStatus(health, false, 4, 'rpc-gateway');

    // Then
    expect(line).toEqual({ tone: 'warn', title: 'Connection is unstable', detail: 'Hub and Identity are behind' });
  });

  it('As a user on trusted providers with one stalled chain, the caption says "is"', () => {
    // Given
    const health: LiveVerdict = { text: 'Waiting on Hub', tone: 'warn', slow: ['Hub'] };

    // When
    const line = describeNetworkStatus(health, false, 4, 'rpc-gateway');

    // Then
    expect(line.detail).toBe('Hub is behind');
  });

  it('As a user on trusted providers who went offline, the caption speaks of providers, not peers', () => {
    // Given
    const health: LiveVerdict = { text: 'Your connection is good', tone: 'ok' };

    // When
    const line = describeNetworkStatus(health, true, 4, 'rpc-gateway');

    // Then
    expect(line).toEqual({
      tone: 'err',
      title: 'You are offline',
      detail: 'Trusted providers are out of reach. Retrying.',
    });
  });
});

describe('describeNetworkStatus with nothing in use', () => {
  it('As a user whose app holds no chain, the menu says none is in use', () => {
    // Given
    const verdict: LiveVerdict = { text: 'Not in use', tone: 'quiet' };

    // When
    const line = describeNetworkStatus(verdict, false, 0, 'smoldot-direct');

    // Then
    expect(line).toEqual({
      tone: 'quiet',
      title: 'No chains in use',
      detail: 'Chains appear here once the app connects to them.',
    });
  });
});

describe('slotOpacity', () => {
  it('As a user reading the history, the oldest slot is half strength and the newest full', () => {
    // When / Then
    expect(HISTORY_SLOTS).toBe(48);
    expect(slotOpacity(0)).toBe('0.50');
    expect(slotOpacity(47)).toBe('1.00');
  });
});
