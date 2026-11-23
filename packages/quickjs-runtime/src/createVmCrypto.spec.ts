// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';

import { startVm } from './testing/startVm.js';

describe('createVmCrypto', () => {
  it('As a module, I fill an integer array with random values and get the same array back', async () => {
    // Given
    const { vm, readMessages } = await startVm({
      'main.js': `const array = new Uint32Array(8);
        const filled = crypto.getRandomValues(array);
        console.log(String(filled === array), String(array.some(value => value !== 0)));`,
    });

    // When
    await vm.run();

    // Then
    expect(readMessages()).toEqual(['true true']);
  });

  it.each([
    ['a float array', 'new Float32Array(4)', 'TypeError'],
    ['more than 65536 bytes', 'new Uint8Array(65537)', 'QuotaExceededError'],
  ])('As a module, I see getRandomValues throw for %s', async (_case, array, name) => {
    // Given
    const { vm, readMessages } = await startVm({
      'main.js': `try {
          crypto.getRandomValues(${array});
        } catch (error) {
          console.log(error.name);
        }`,
    });

    // When
    await vm.run();

    // Then
    expect(readMessages()).toEqual([name]);
  });

  it('As a module, I digest bytes through subtle and get the host digest', async () => {
    // Given
    const { vm, untilLogged, readMessages } = await startVm({
      'main.js': `const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('abc'));
        console.log([...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join(''));`,
    });

    // When
    await vm.run();
    await untilLogged(1);

    // Then
    expect(readMessages()).toEqual(['ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad']);
  });

  it('As a module, I generate a key pair, sign with its private key and verify with its public key', async () => {
    // Given
    const { vm, untilLogged, readMessages } = await startVm({
      'main.js': `const algorithm = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
        const { publicKey, privateKey } = await crypto.subtle.generateKey(algorithm, false, ['sign', 'verify']);
        const data = new Uint8Array([1, 2, 3]);
        const signature = await crypto.subtle.sign(algorithm, privateKey, data);
        const verified = await crypto.subtle.verify(algorithm, publicKey, signature, data);
        const isKey = privateKey instanceof CryptoKey;
        console.log(String(isKey), privateKey.type, publicKey.algorithm.namedCurve, String(verified));`,
    });

    // When
    await vm.run();
    await untilLogged(1);

    // Then
    expect(readMessages()).toEqual(['true private P-256 true']);
  });

  it('As a module, I see a subtle call the host WebCrypto refuses reject with its name', async () => {
    // Given
    const { vm, untilLogged, readMessages } = await startVm({
      'main.js': `crypto.subtle.digest('SHA-999', new Uint8Array([1])).catch(error => console.log(error.name));`,
    });

    // When
    await vm.run();
    await untilLogged(1);

    // Then
    expect(readMessages()).toEqual(['NotSupportedError']);
  });
});
