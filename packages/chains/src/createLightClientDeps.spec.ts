// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import type { LightClientDeps } from './createLightClient.js';
import { createLightClientDeps } from './createLightClientDeps.js';

describe('createLightClientDeps', () => {
  function createSession(entries: Record<string, string>): Pick<Storage, 'getItem'> {
    return { getItem: key => entries[key] ?? null };
  }

  it.each<{
    role: string;
    session: Parameters<typeof createLightClientDeps>[0];
    local: boolean;
    level: LightClientDeps['logLevel'];
  }>([
    { role: 'a developer on localhost', session: null, local: true, level: 'info' },
    { role: 'a visitor in production', session: null, local: false, level: 'off' },
    {
      role: 'a tester who sets debug in my session',
      session: createSession({ 'dotli:truapi-provider-log': 'debug' }),
      local: false,
      level: 'debug',
    },
  ])('As $role, I see the light client log at level $level', ({ session, local, level }) => {
    // When
    const { logLevel } = createLightClientDeps(session, local);

    // Then
    expect(logLevel).toBe(level);
  });

  it('As a tester, I set a heartbeat interval in my session and it slows the heartbeat, and a bad one is ignored', () => {
    // When
    const slowed = createLightClientDeps(createSession({ 'dotli:smoldot-heartbeat-ms': '3600000' }), false);
    const bad = createLightClientDeps(createSession({ 'dotli:smoldot-heartbeat-ms': 'soon' }), false);

    // Then
    expect(slowed.heartbeatMs).toBe(3_600_000);
    expect(bad.heartbeatMs).toBeUndefined();
  });

  it('As a dotli operator on a build with metrics, I see my gauge report the running light client', () => {
    // Given
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const { gauge } = createLightClientDeps(null, false);

    // When
    gauge?.(1);

    // Then
    expect(metrics.gauges).toEqual([{ name: 'dotli.smoldot.active', value: 1, unit: 'none', attributes: undefined }]);
  });
});
