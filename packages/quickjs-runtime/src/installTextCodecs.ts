// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { QuickJSContext } from 'quickjs-emscripten-core';

import type { VmBytes } from './createVmBytes.js';
import { runVmInstaller } from './runVmInstaller.js';

// The classes live in the VM so `instanceof`, getters and private state behave as the VM's code expects. The host does
// the encoding itself.
const INSTALLER_SOURCE = `({ encodeText, decodeText, resolveEncoding }) => {
  class TextEncoder {
    get encoding() {
      return 'utf-8';
    }
    encode(input = '') {
      return encodeText(String(input));
    }
  }

  class TextDecoder {
    #encoding;
    constructor(label = 'utf-8') {
      this.#encoding = resolveEncoding(String(label));
    }
    get encoding() {
      return this.#encoding;
    }
    decode(input) {
      if (input === undefined) {
        return '';
      }
      if (ArrayBuffer.isView(input)) {
        return decodeText(this.#encoding, input);
      }
      if (input instanceof ArrayBuffer) {
        return decodeText(this.#encoding, new Uint8Array(input));
      }
      throw new TypeError('TextDecoder.decode takes an ArrayBuffer or a view of one');
    }
  }

  globalThis.TextEncoder = TextEncoder;
  globalThis.TextDecoder = TextDecoder;
}`;

/**
 * Sets the VM's `TextEncoder` and `TextDecoder`. A decoder takes any label the host's `TextDecoder` knows, and its
 * constructor throws a `RangeError` in the VM for any other.
 *
 * Throws when the VM cannot install them.
 */
export function installTextCodecs(vm: QuickJSContext, bytes: VmBytes): void {
  const encoder = new TextEncoder();
  runVmInstaller(vm, INSTALLER_SOURCE, {
    encodeText: text => bytes.toVm(encoder.encode(vm.getString(text))),
    decodeText: (encoding, view) => vm.newString(new TextDecoder(vm.getString(encoding)).decode(bytes.fromVm(view))),
    resolveEncoding: label => vm.newString(new TextDecoder(vm.getString(label)).encoding),
  });
}
