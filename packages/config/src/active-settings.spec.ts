// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { activeSettings, setSettings, subscribeSettings } from './active-settings.js';
import { NetworkName } from './network.js';
import { getSettings } from './settings.js';

describe('subscribeSettings', () => {
  it('As a reader of the settings, I hear when boot sets them and when they are put back', () => {
    // Given
    const heard: (NetworkName | undefined)[] = [];
    const unsubscribe = subscribeSettings(() => heard.push(activeSettings()?.network));

    // When
    const restore = setSettings({ ...getSettings(), network: NetworkName.PREVIEWNET });
    restore();
    unsubscribe();
    setSettings({ ...getSettings(), network: NetworkName.PASEO })();

    // Then
    expect(heard).toEqual([NetworkName.PREVIEWNET, undefined]);
  });
});
