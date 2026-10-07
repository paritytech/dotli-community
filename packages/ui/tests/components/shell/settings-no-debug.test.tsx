// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { flush } from 'solid-js';
import { cleanup } from '@solidjs/testing-library';
import type * as ConfigModule from '../../../../config/src/config.js';
import { SettingsPopover } from '../../../src/components/shell/SettingsPopover.js';
import { initSettingsStore } from '../../../src/state/settings.js';
import { renderComponent, resetStores, waitForContent } from '../../helpers/solid.js';
import { byId } from '../../support.js';

// A build without VITE_APP_DEBUG, as the production deployments are.
vi.mock('../../../../config/src/config.js', async importOriginal => ({
  ...(await importOriginal<typeof ConfigModule>()),
  DEBUG: false,
}));

beforeAll(async () => {
  await import('../../../src/components/shell/SettingsContent.js');
});

afterEach(() => {
  // Before the body goes: the popover is portaled into it.
  cleanup();
  resetStores();
  document.body.innerHTML = '';
});

describe('The settings popover in a build without debug', () => {
  it('As a user of a production deployment, the settings show no Diagnostics column', async () => {
    // Given
    initSettingsStore();
    renderComponent(() => <SettingsPopover />);
    flush();

    // When
    byId('mode-button').click();
    flush();
    await waitForContent('mode-popover');
    flush();

    // Then
    const columns = byId('mode-popover').querySelector('[data-testid="mode-popover-columns"]');
    expect(columns?.childElementCount).toBe(1);
    expect(document.querySelector('[data-testid="mode-diagnostics"]')).toBeNull();
  });
});
