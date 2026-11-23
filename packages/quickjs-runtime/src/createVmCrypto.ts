// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The VM's `crypto` and `CryptoKey`, run on a WebCrypto the caller passes in. A real key never enters the VM. The VM
// holds a frozen `CryptoKey` that names it by id, and the host keeps the key under that id until the VM's wrapper is
// collected.
//
// Values cross as JSON with markers in place of what JSON cannot carry. Bytes ride beside it as a list of typed arrays:
//
// - `{ $bytes: index }`: an `ArrayBuffer` or a view, at `index` in the list
// - `{ $key: id }`: a key the VM passes in
// - `{ $newKey: { id, type, extractable, algorithm, usages } }`: a key the host hands out

import { isRecord } from '@dotli/shared';
import type { QuickJSContext, QuickJSDeferredPromise, QuickJSHandle } from 'quickjs-emscripten-core';

import type { VmBytes } from './createVmBytes.js';
import { runVmInstaller } from './runVmInstaller.js';
import { runVmJobs } from './runVmJobs.js';

type Params = {
  vm: QuickJSContext;
  bytes: VmBytes;
  crypto: Crypto;
  /** Hears a result that could not reach the VM, and a job that failed after a subtle call settled. */
  onError: (error: Error) => void;
};

type SubtleMethod =
  | 'digest'
  | 'sign'
  | 'verify'
  | 'encrypt'
  | 'decrypt'
  | 'generateKey'
  | 'deriveBits'
  | 'deriveKey'
  | 'importKey'
  | 'exportKey'
  | 'wrapKey'
  | 'unwrapKey';

const SUBTLE_METHODS: readonly SubtleMethod[] = [
  'digest',
  'sign',
  'verify',
  'encrypt',
  'decrypt',
  'generateKey',
  'deriveBits',
  'deriveKey',
  'importKey',
  'exportKey',
  'wrapKey',
  'unwrapKey',
];

const INSTALLER_SOURCE = `({ getRandomBytes, callSubtle, releaseKey }) => {
  const integerArrays = [
    Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, BigInt64Array,
    BigUint64Array,
  ];

  function getRandomValues(array) {
    if (!integerArrays.some(IntegerArray => array instanceof IntegerArray)) {
      throw new TypeError('crypto.getRandomValues takes an integer typed array');
    }
    new Uint8Array(array.buffer, array.byteOffset, array.byteLength).set(getRandomBytes(array.byteLength));
    return array;
  }

  class CryptoKey {
    constructor() {
      throw new TypeError('Illegal constructor');
    }
  }
  Object.defineProperty(CryptoKey.prototype, Symbol.toStringTag, { value: 'CryptoKey', configurable: true });

  const keyIds = new WeakMap();
  // Lets the host drop a real key once the VM can no longer reach its wrapper, so a long-lived VM does not leak keys.
  const collected = new FinalizationRegistry(id => releaseKey(id));

  function toKey({ id, type, extractable, algorithm, usages }, bytes) {
    const key = Object.create(CryptoKey.prototype);
    Object.defineProperties(key, {
      type: { value: type, enumerable: true },
      extractable: { value: extractable, enumerable: true },
      algorithm: { value: Object.freeze(fromHost(algorithm, bytes)), enumerable: true },
      usages: { value: Object.freeze([...usages]), enumerable: true },
    });
    keyIds.set(key, id);
    collected.register(key, id);
    return key;
  }

  function toHost(value, bytes) {
    if (value === null || typeof value !== 'object') {
      return value;
    }
    if (value instanceof CryptoKey) {
      return { $key: keyIds.get(value) };
    }
    if (value instanceof ArrayBuffer) {
      bytes.push(new Uint8Array(value));
      return { $bytes: bytes.length - 1 };
    }
    if (ArrayBuffer.isView(value)) {
      bytes.push(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
      return { $bytes: bytes.length - 1 };
    }
    if (Array.isArray(value)) {
      return value.map(item => toHost(item, bytes));
    }
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, toHost(item, bytes)]));
  }

  function fromHost(value, bytes) {
    if (value === null || typeof value !== 'object') {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map(item => fromHost(item, bytes));
    }
    if (typeof value.$bytes === 'number') {
      return bytes[value.$bytes].buffer;
    }
    if (value.$newKey) {
      return toKey(value.$newKey, bytes);
    }
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, fromHost(item, bytes)]));
  }

  // Async, so a call the host refuses rejects rather than throws, as WebCrypto does.
  async function call(method, args) {
    const bytes = [];
    const json = JSON.stringify(toHost(args, bytes));
    const result = await callSubtle(method, json, bytes);
    return fromHost(JSON.parse(result.json), result.bytes);
  }

  const subtle = {
    digest: (...args) => call('digest', args),
    sign: (...args) => call('sign', args),
    verify: (...args) => call('verify', args),
    encrypt: (...args) => call('encrypt', args),
    decrypt: (...args) => call('decrypt', args),
    generateKey: (...args) => call('generateKey', args),
    deriveBits: (...args) => call('deriveBits', args),
    deriveKey: (...args) => call('deriveKey', args),
    importKey: (...args) => call('importKey', args),
    exportKey: (...args) => call('exportKey', args),
    wrapKey: (...args) => call('wrapKey', args),
    unwrapKey: (...args) => call('unwrapKey', args),
  };
  Object.defineProperty(subtle, Symbol.toStringTag, { value: 'SubtleCrypto', configurable: true });

  globalThis.crypto = { getRandomValues, subtle };
  globalThis.CryptoKey = CryptoKey;
}`;

/**
 * Sets the VM's `crypto.getRandomValues`, `crypto.subtle` and `CryptoKey` on `crypto`. A subtle call settles as a VM
 * promise, and a failure of `crypto` reaches the VM as a rejection with the same name and message.
 *
 * Throws when the VM cannot install them.
 */
export function createVmCrypto({ vm, bytes, crypto, onError }: Params) {
  const keys = new Map<number, CryptoKey>();
  const pending = new Set<QuickJSDeferredPromise>();
  let nextKeyId = 1;

  runVmInstaller(vm, INSTALLER_SOURCE, {
    getRandomBytes: length => bytes.toVm(crypto.getRandomValues(new Uint8Array(vm.getNumber(length)))),
    callSubtle(method, json, list) {
      const name = vm.getString(method);
      const subtleMethod = SUBTLE_METHODS.find(known => known === name);
      if (!subtleMethod) {
        throw new TypeError(`SubtleCrypto has no method '${name}'`);
      }
      const args = parseArgs(vm.getString(json), readByteList(list));
      const deferred = vm.newPromise();
      pending.add(deferred);
      const subtle = crypto.subtle;
      // The arguments come from the VM, so WebCrypto checks them as it would a page's. A method that throws rather than
      // rejects still reaches the VM as a rejection.
      void Promise.resolve()
        // eslint-disable-next-line @typescript-eslint/unbound-method -- Reflect.apply calls it on `subtle`
        .then((): unknown => Reflect.apply(subtle[subtleMethod], subtle, args))
        .then(
          value => {
            settle(deferred, () => buildResponse(value), 'resolve');
          },
          (error: unknown) => {
            settle(deferred, () => buildError(error), 'reject');
          },
        );
      return deferred.handle;
    },
    releaseKey(id) {
      keys.delete(vm.getNumber(id));
    },
  });

  return {
    /** Drops the keys and frees the promises of calls in flight, whose results never reach the VM. Safe to repeat. */
    dispose() {
      keys.clear();
      for (const deferred of pending) {
        deferred.dispose();
      }
      pending.clear();
    },
  };

  /** Settles a call still in flight with the value `build` makes, then runs the jobs it queued. */
  function settle(deferred: QuickJSDeferredPromise, build: () => QuickJSHandle, outcome: 'resolve' | 'reject'): void {
    if (!pending.delete(deferred)) {
      return;
    }
    try {
      const value = build();
      deferred[outcome](value);
      value.dispose();
    } catch (error) {
      deferred.dispose();
      onError(new Error('A subtle crypto result could not reach the VM', { cause: error }));
      return;
    }
    runVmJobs(vm, onError, 'a subtle crypto call');
  }

  function parseArgs(json: string, list: Uint8Array[]): unknown[] {
    const args = fromVmValue(JSON.parse(json), list);
    if (!Array.isArray(args)) {
      throw new TypeError('A subtle crypto call needs a list of arguments');
    }
    return args;
  }

  function fromVmValue(value: unknown, list: Uint8Array[]): unknown {
    if (Array.isArray(value)) {
      return value.map(item => fromVmValue(item, list));
    }
    if (!isRecord(value)) {
      return value;
    }
    const byteIndex = value['$bytes'];
    if (typeof byteIndex === 'number') {
      const found = list[byteIndex];
      if (!found) {
        throw new TypeError(`A subtle crypto call names bytes ${String(byteIndex)} it did not pass`);
      }
      return found;
    }
    if ('$key' in value) {
      const key = typeof value['$key'] === 'number' ? keys.get(value['$key']) : undefined;
      if (!key) {
        throw new TypeError(`A subtle crypto call passes a key this VM does not hold: ${String(value['$key'])}`);
      }
      return key;
    }
    // `fromEntries` defines each key as an own property, so a `__proto__` key from the VM sets no prototype.
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, fromVmValue(item, list)]));
  }

  function toVmValue(value: unknown, list: Uint8Array[]): unknown {
    if (value instanceof ArrayBuffer) {
      list.push(new Uint8Array(value));
      return { $bytes: list.length - 1 };
    }
    if (ArrayBuffer.isView(value)) {
      list.push(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
      return { $bytes: list.length - 1 };
    }
    if (value instanceof CryptoKey) {
      const id = nextKeyId;
      nextKeyId += 1;
      keys.set(id, value);
      const { type, extractable, algorithm, usages } = value;
      return { $newKey: { id, type, extractable, algorithm: toVmValue(algorithm, list), usages } };
    }
    if (Array.isArray(value)) {
      return value.map(item => toVmValue(item, list));
    }
    // A key pair is a plain object, so each of its keys converts on its own.
    if (isRecord(value)) {
      return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, toVmValue(item, list)]));
    }
    return value;
  }

  function readByteList(list: QuickJSHandle): Uint8Array[] {
    const length = vm.getProp(list, 'length');
    const count = vm.getNumber(length);
    length.dispose();
    const read: Uint8Array[] = [];
    for (let index = 0; index < count; index += 1) {
      const view = vm.getProp(list, index);
      try {
        read.push(bytes.fromVm(view));
      } finally {
        view.dispose();
      }
    }
    return read;
  }

  /** The VM's `{ json, bytes }` for a call's result. The caller disposes it. */
  function buildResponse(value: unknown): QuickJSHandle {
    const list: Uint8Array[] = [];
    const json = JSON.stringify(toVmValue(value, list) ?? null);
    const response = vm.newObject();
    const jsonHandle = vm.newString(json);
    vm.setProp(response, 'json', jsonHandle);
    jsonHandle.dispose();
    const listHandle = vm.newArray();
    for (const [index, item] of list.entries()) {
      const view = bytes.toVm(item);
      vm.setProp(listHandle, index, view);
      view.dispose();
    }
    vm.setProp(response, 'bytes', listHandle);
    listHandle.dispose();
    return response;
  }

  /** The VM's error for a call that failed, keeping the name WebCrypto gave it, such as `OperationError`. */
  function buildError(error: unknown): QuickJSHandle {
    return error instanceof Error
      ? vm.newError({ name: error.name, message: error.message })
      : vm.newError(String(error));
  }
}
