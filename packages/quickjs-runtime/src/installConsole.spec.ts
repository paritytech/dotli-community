// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';

import { startVm } from './testing/startVm.js';

describe('installConsole', () => {
  it('As a host, I hear a module console call as its level and the message its arguments format to', async () => {
    // Given
    const { vm, logs } = await startVm({
      'main.js': `console.warn('%s has %d items', 'cart', 3.7, { total: 2 });
        console.log();`,
    });

    // When
    await vm.run();

    // Then
    expect(logs).toEqual([
      { level: 'warn', message: 'cart has 3 items {"total":2}' },
      { level: 'log', message: '' },
    ]);
  });

  it('As a host, I hear a module message with its control characters replaced, so it drives no terminal', async () => {
    // Given
    const { vm, readMessages } = await startVm({ 'main.js': `console.error('\\x1b[2J\\rdone\\tok');` });

    // When
    await vm.run();

    // Then
    expect(readMessages()).toEqual(['�[2J�done\tok']);
  });
});
