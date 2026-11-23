// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';

import { startVm } from './testing/startVm.js';

describe('createQuickJsVm', () => {
  it('As a host, I hear the bytes a module posts on the host API port', async () => {
    // Given
    const { vm, frames } = await startVm({ 'main.js': `__HOST_API_PORT__.postMessage(new Uint8Array([1, 2, 3]));` });

    // When
    await vm.run();

    // Then
    expect(frames).toEqual([new Uint8Array([1, 2, 3])]);
  });

  it('As a host, I post bytes that reach the listener a module added, and hear its reply', async () => {
    // Given
    const { vm, frames } = await startVm({
      'main.js': `__HOST_API_PORT__.addEventListener('message', event => {
        Promise.resolve().then(() => __HOST_API_PORT__.postMessage(event.data.map(byte => byte * 2)));
      });`,
    });
    await vm.run();

    // When
    vm.wire.postMessage(new Uint8Array([4, 5]));

    // Then
    expect(frames).toEqual([new Uint8Array([8, 10])]);
  });

  it('As a host, I run an entrypoint whose relative imports resolve against the importing module', async () => {
    // Given
    const { vm, frames } = await startVm(
      {
        'app/main.js': `import { reply } from './lib/reply.js'; reply();`,
        'app/lib/reply.js': `import { BYTE } from '../constants.js';
          export function reply() { __HOST_API_PORT__.postMessage(new Uint8Array([BYTE])); }`,
        'app/constants.js': `export const BYTE = 7;`,
      },
      { entrypoint: 'app/main.js' },
    );

    // When
    await vm.run();

    // Then
    expect(frames).toEqual([new Uint8Array([7])]);
  });

  it.each([
    ['an import is not in the files', { 'main.js': `import './missing.js';` }, /missing\.js/],
    ['the module throws', { 'main.js': `throw new TypeError('broken worker');` }, /TypeError: broken worker/],
    [
      'its top-level await rejects',
      { 'main.js': `await Promise.reject(new Error('late failure'));` },
      /Error: late failure/,
    ],
    ['the entrypoint is not in the files', { 'other.js': `` }, /main\.js/],
  ])('As a host, I see the run reject with the VM message when %s', async (_case, files, message) => {
    // Given
    const { vm } = await startVm(files);

    // When
    const run = vm.run();

    // Then
    await expect(run).rejects.toThrow(message);
  });

  it('As a module, I find window and top as the global object, and cannot replace them', async () => {
    // Given
    const { vm, frames } = await startVm({
      'main.js': `const original = window;
        try { window = {}; } catch {}
        __HOST_API_PORT__.postMessage(new Uint8Array([
          window === globalThis && top === globalThis && original === window ? 1 : 0,
          __HOST_WEBVIEW_MARK__ === true ? 1 : 0,
        ]));`,
    });

    // When
    await vm.run();

    // Then
    expect(frames).toEqual([new Uint8Array([1, 1])]);
  });

  it('As a host, I dispose the VM twice safely, and my bytes no longer reach the module', async () => {
    // Given
    const { vm, frames } = await startVm({
      'main.js': `__HOST_API_PORT__.onmessage = event => __HOST_API_PORT__.postMessage(event.data);`,
    });
    await vm.run();

    // When
    vm.dispose();
    vm.dispose();
    vm.wire.postMessage(new Uint8Array([1]));

    // Then
    expect(frames).toEqual([]);
  });

  it('As a host, I hear once of a module that adds the same listener twice', async () => {
    // Given
    const { vm, frames } = await startVm({
      'main.js': `const echo = event => __HOST_API_PORT__.postMessage(event.data);
        __HOST_API_PORT__.addEventListener('message', echo);
        __HOST_API_PORT__.addEventListener('message', echo);`,
    });
    await vm.run();

    // When
    vm.wire.postMessage(new Uint8Array([9]));

    // Then
    expect(frames).toEqual([new Uint8Array([9])]);
  });

  it('As a host, I am told of a listener in the module that throws, and the next listener still hears', async () => {
    // Given
    const { vm, frames, errors } = await startVm({
      'main.js': `__HOST_API_PORT__.onmessage = () => { throw new RangeError('bad frame'); };
        __HOST_API_PORT__.addEventListener('message', event => __HOST_API_PORT__.postMessage(event.data));`,
    });
    await vm.run();

    // When
    vm.wire.postMessage(new Uint8Array([3]));

    // Then
    expect({ frames, errors: errors.map(error => error.message) }).toEqual({
      frames: [new Uint8Array([3])],
      errors: ['A message listener in the VM threw: RangeError: bad frame'],
    });
  });

  it('As a host, I am told when a module adds listeners past the cap, and the extra ones never hear', async () => {
    // Given
    const { vm, frames, errors } = await startVm({
      'main.js': `for (let index = 0; index < 33; index += 1) {
          __HOST_API_PORT__.addEventListener('message', () => __HOST_API_PORT__.postMessage(new Uint8Array([index])));
        }`,
    });
    await vm.run();

    // When
    vm.wire.postMessage(new Uint8Array([0]));

    // Then
    expect({ heard: frames.length, errors: errors.map(error => error.message) }).toEqual({
      heard: 32,
      errors: ['The VM added more than 32 message listeners'],
    });
  });
});
