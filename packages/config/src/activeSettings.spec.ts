// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { activeSettings, setSettings, subscribeSettings } from './activeSettings.js';
import type { Network } from './networkNames.js';
import { getSettings } from './settings.js';

describe('subscribeSettings', () => {
  it('As a reader of the settings, I hear when boot sets them and when they are put back', () => {
    // Given
    const heard: (Network | undefined)[] = [];
    const unsubscribe = subscribeSettings(() => heard.push(activeSettings()?.network));

    // When
    const restore = setSettings({ ...getSettings(), network: 'previewnet' });
    restore();
    unsubscribe();
    setSettings({ ...getSettings(), network: 'paseo-next-v2' })();

    // Then
    expect(heard).toEqual(['previewnet', undefined]);
  });
});
