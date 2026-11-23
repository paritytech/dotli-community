// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';

import { startVm } from './testing/startVm.js';

describe('installTextCodecs', () => {
  it('As a module, I encode text to UTF-8 and decode it back from a view or a buffer', async () => {
    // Given
    const { vm, frames, readMessages } = await startVm({
      'main.js': `const bytes = new TextEncoder().encode('xhé');
        __HOST_API_PORT__.postMessage(bytes);
        const decoder = new TextDecoder();
        console.log(decoder.decode(bytes.subarray(1)), decoder.decode(bytes.buffer.slice(1)), decoder.encoding);`,
    });

    // When
    await vm.run();

    // Then
    expect({ frames, messages: readMessages() }).toEqual({
      frames: [new Uint8Array([0x78, 0x68, 0xc3, 0xa9])],
      messages: ['hé hé utf-8'],
    });
  });

  it('As a module, I see a RangeError when I ask for an encoding the host does not know', async () => {
    // Given
    const { vm, readMessages } = await startVm({
      'main.js': `try {
          new TextDecoder('no-such-encoding');
        } catch (error) {
          console.log(error.name);
        }`,
    });

    // When
    await vm.run();

    // Then
    expect(readMessages()).toEqual(['RangeError']);
  });
});
