// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';

import { startVm } from './testing/startVm.js';

describe('createVmTimers', () => {
  it('As a module, I see my timeout fire once its delay passes, with the jobs it queued run after it', async () => {
    // Given
    const { vm, timers, readMessages } = await startVm({
      'main.js': `setTimeout(() => Promise.resolve().then(() => console.log('fired')), 50);`,
    });
    await vm.run();
    await timers.advance(49);
    const early = readMessages();

    // When
    await timers.advance(1);

    // Then
    expect({ early, late: readMessages() }).toEqual({ early: [], late: ['fired'] });
  });

  it('As a module, I clear my interval from its own callback, and it fires no more', async () => {
    // Given
    const { vm, timers, readMessages } = await startVm({
      'main.js': `let count = 0;
        const id = setInterval(() => {
          count += 1;
          console.log(String(count));
          if (count === 3) {
            clearInterval(id);
          }
        }, 10);`,
    });
    await vm.run();

    // When
    await timers.advance(100);

    // Then
    expect({ messages: readMessages(), pending: timers.countPending() }).toEqual({
      messages: ['1', '2', '3'],
      pending: 0,
    });
  });

  it('As a host, I dispose the VM, and every timer the module set is cleared', async () => {
    // Given
    const { vm, timers } = await startVm({
      'main.js': `setTimeout(() => console.log('timeout'), 10);
        setInterval(() => console.log('interval'), 10);`,
    });
    await vm.run();

    // When
    vm.dispose();

    // Then
    expect(timers.countPending()).toBe(0);
  });

  it('As a host, I am told of a timer callback in the module that throws', async () => {
    // Given
    const { vm, timers, errors } = await startVm({
      'main.js': `setTimeout(() => { throw new TypeError('late failure'); }, 10);`,
    });
    await vm.run();

    // When
    await timers.advance(10);

    // Then
    expect(errors.map(error => error.message)).toEqual(['A timer callback in the VM threw: TypeError: late failure']);
  });

  it('As a module, I see my microtask run after the code that queued it', async () => {
    // Given
    const { vm, untilLogged, readMessages } = await startVm({
      'main.js': `queueMicrotask(() => console.log('microtask'));
        console.log('sync');`,
    });

    // When
    await vm.run();
    await untilLogged(2);

    // Then
    expect(readMessages()).toEqual(['sync', 'microtask']);
  });

  it('As a host, I am told once of a module that queues microtasks past the cap', async () => {
    // Given
    const { vm, errors } = await startVm({
      'main.js': `for (let index = 0; index < 1100; index += 1) {
          queueMicrotask(() => {});
        }`,
    });

    // When
    await vm.run();

    // Then
    expect(errors.map(error => error.message)).toEqual([
      'The VM queued more than 1024 microtasks, so some were dropped',
    ]);
  });
});
