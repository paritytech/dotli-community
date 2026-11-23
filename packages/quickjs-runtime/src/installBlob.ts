// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { QuickJSContext, QuickJSHandle } from 'quickjs-emscripten-core';

// Evaluated by the VM, not by the browser, so it stays a string
// (docs/decisions/source-an-embedded-interpreter-evaluates.md). It evaluates to the function that reads a blob's bytes,
// which only the host holds, so VM code cannot change the bytes of a blob it was handed.
const SOURCE = `(() => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const blobs = new WeakMap();

  function readBlob(blob) {
    const state = blobs.get(blob);
    if (!state) {
      throw new TypeError('Illegal invocation');
    }
    return state;
  }

  function readBlobBytes(blob) {
    return readBlob(blob).bytes;
  }

  function toBlobPart(part) {
    if (typeof part === 'string') {
      return encoder.encode(part);
    }
    if (blobs.has(part)) {
      return readBlobBytes(part);
    }
    if (part instanceof ArrayBuffer) {
      return new Uint8Array(part);
    }
    if (ArrayBuffer.isView(part)) {
      return new Uint8Array(part.buffer, part.byteOffset, part.byteLength);
    }
    return encoder.encode(String(part));
  }

  // A type with a character outside printable ASCII is dropped, as in a browser.
  function normalizeType(type) {
    const text = type === undefined ? '' : String(type);
    return /^[\\x20-\\x7e]*$/.test(text) ? text.toLowerCase() : '';
  }

  function createBlob(bytes, type) {
    const blob = Object.create(Blob.prototype);
    blobs.set(blob, { bytes, type });
    return blob;
  }

  class Blob {
    constructor(parts = [], options = {}) {
      const chunks = [...(parts ?? [])].map(toBlobPart);
      const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      blobs.set(this, { bytes, type: normalizeType(options?.type) });
    }
    get size() {
      return readBlobBytes(this).byteLength;
    }
    get type() {
      return readBlob(this).type;
    }
    async arrayBuffer() {
      return readBlobBytes(this).slice().buffer;
    }
    async bytes() {
      return readBlobBytes(this).slice();
    }
    async text() {
      return decoder.decode(readBlobBytes(this));
    }
    slice(start, end, contentType) {
      return createBlob(readBlobBytes(this).slice(start, end), normalizeType(contentType));
    }
  }
  Object.defineProperty(Blob.prototype, Symbol.toStringTag, { value: 'Blob', configurable: true });

  const forms = new WeakMap();

  function readEntries(form) {
    const entries = forms.get(form);
    if (!entries) {
      throw new TypeError('Illegal invocation');
    }
    return entries;
  }

  function toFormValue(value) {
    return blobs.has(value) ? value : String(value);
  }

  class FormData {
    constructor() {
      forms.set(this, []);
    }
    append(name, value) {
      readEntries(this).push([String(name), toFormValue(value)]);
    }
    set(name, value) {
      const key = String(name);
      const entry = [key, toFormValue(value)];
      // The first entry of the name takes the value and the others go, as in a browser.
      const next = [];
      let placed = false;
      for (const current of readEntries(this)) {
        if (current[0] !== key) {
          next.push(current);
        } else if (!placed) {
          next.push(entry);
          placed = true;
        }
      }
      if (!placed) {
        next.push(entry);
      }
      forms.set(this, next);
    }
    delete(name) {
      const key = String(name);
      forms.set(this, readEntries(this).filter(([entryName]) => entryName !== key));
    }
    get(name) {
      const key = String(name);
      return readEntries(this).find(([entryName]) => entryName === key)?.[1] ?? null;
    }
    getAll(name) {
      const key = String(name);
      return readEntries(this).filter(([entryName]) => entryName === key).map(([, value]) => value);
    }
    has(name) {
      const key = String(name);
      return readEntries(this).some(([entryName]) => entryName === key);
    }
    *entries() {
      for (const [name, value] of readEntries(this)) {
        yield [name, value];
      }
    }
    *keys() {
      for (const [name] of readEntries(this)) {
        yield name;
      }
    }
    *values() {
      for (const [, value] of readEntries(this)) {
        yield value;
      }
    }
    forEach(callback, thisArg) {
      for (const [name, value] of this.entries()) {
        callback.call(thisArg, value, name, this);
      }
    }
  }
  FormData.prototype[Symbol.iterator] = FormData.prototype.entries;
  Object.defineProperty(FormData.prototype, Symbol.toStringTag, { value: 'FormData', configurable: true });

  globalThis.Blob = Blob;
  globalThis.FormData = FormData;

  return readBlobBytes;
})()`;

/**
 * Sets the VM's `Blob` and `FormData`, and returns the VM function that reads a blob's bytes without a copy, which VM
 * code cannot reach. The caller disposes the handle.
 *
 * Throws when the VM cannot install them, or when the text codecs are not installed first.
 */
export function installBlob(vm: QuickJSContext): QuickJSHandle {
  return vm.unwrapResult(vm.evalCode(SOURCE));
}
