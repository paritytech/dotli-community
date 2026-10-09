// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { getSettingsState } from '../../src/state/settings.js';

import { resetStores } from '../helpers/solid.js';

describe('settings store', () => {
  afterEach(() => {
    resetStores();
    localStorage.clear();
  });

  it('As the prerendered shell, the settings store is empty until the host seeds it', () => {
    expect(getSettingsState()).toBeNull();
  });
});
