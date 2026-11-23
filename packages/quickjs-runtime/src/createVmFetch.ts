// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The VM's `fetch`, `Headers`, `Request` and `Response`, run on a fetch the caller passes in. The VM builds the request,
// the host hands it to the caller's fetch, and the response comes back as bytes. A request that crosses is a JSON head
// of method, URL and headers, with its body beside it as a typed array.

import { isRecord } from '@dotli/shared';
import type { QuickJSContext, QuickJSDeferredPromise, QuickJSHandle } from 'quickjs-emscripten-core';

import type { VmBytes } from './createVmBytes.js';
import { defineVmFunctions } from './defineVmFunctions.js';
import { runVmJobs } from './runVmJobs.js';

/** One request of the VM's `fetch`, as the host's fetch gets it. `body` is `null` when the request has none. */
export type HostFetchRequest = {
  method: string;
  url: string;
  headers: [string, string][];
  body: Uint8Array | null;
  /** Aborts when the VM's code aborts the request, or when the VM is disposed. */
  signal: AbortSignal;
};

/** The host's answer to one request. `url` is the final URL, after any redirect. */
export type HostFetchResponse = {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: Uint8Array;
  url: string;
};

/**
 * The host's side of one request of the VM's `fetch`. A rejection rejects the VM's `fetch` with the same name and
 * message.
 */
export type HostFetch = (request: HostFetchRequest) => Promise<HostFetchResponse>;

type Params = {
  vm: QuickJSContext;
  bytes: VmBytes;
  /** The VM function that reads a blob's bytes, which VM code cannot reach. */
  readBlobBytes: QuickJSHandle;
  fetch: HostFetch;
  /** The largest request body the host copies out of the VM. */
  maxBodyBytes: number;
  /** Hears a response that could not reach the VM, and a job that failed after a request settled. */
  onError: (error: Error) => void;
};

type InFlight = {
  controller: AbortController;
  deferred: QuickJSDeferredPromise;
};

// Evaluated by the VM, not by the browser, so it stays a string
// (docs/decisions/source-an-embedded-interpreter-evaluates.md). The globals it builds on are bound when it runs, so VM
// code that later replaces one cannot change what a request carries.
const INSTALLER_SOURCE = `({ sendRequest, abortRequest }, readBlobBytes) => {
  const { AbortController, AbortSignal, Blob, FormData } = globalThis;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const HEADER_NAME = /^[!#$%&'*+.^_|~0-9A-Za-z\\x60-]+$/;
  const HEADER_VALUE_EDGES = /^[\\t\\n\\r ]+|[\\t\\n\\r ]+$/g;
  const FORBIDDEN_IN_HEADER_VALUE = /[\\0\\n\\r]/;
  const NORMALIZED_METHODS = ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'POST', 'PUT'];
  const FORBIDDEN_METHODS = ['CONNECT', 'TRACE', 'TRACK'];
  const REDIRECT_STATUSES = [301, 302, 303, 307, 308];
  const NULL_BODY_STATUSES = [101, 103, 204, 205, 304];

  const headerLists = new WeakMap();

  function readHeaders(headers) {
    const list = headerLists.get(headers);
    if (!list) {
      throw new TypeError('Illegal invocation');
    }
    return list;
  }

  function toHeaderName(name) {
    const text = String(name);
    if (!HEADER_NAME.test(text)) {
      throw new TypeError("Invalid header name '" + text + "'");
    }
    return text.toLowerCase();
  }

  function toHeaderValue(value) {
    const text = String(value).replace(HEADER_VALUE_EDGES, '');
    if (FORBIDDEN_IN_HEADER_VALUE.test(text)) {
      throw new TypeError("Invalid header value '" + text + "'");
    }
    return text;
  }

  // Sorted by name with values of one name combined, as a browser lists them, except set-cookie, which stays apart.
  function listHeaders(headers) {
    const byName = readHeaders(headers);
    const listed = [];
    for (const name of [...byName.keys()].sort()) {
      const values = byName.get(name);
      if (name === 'set-cookie') {
        listed.push(...values.map(value => [name, value]));
      } else {
        listed.push([name, values.join(', ')]);
      }
    }
    return listed;
  }

  class Headers {
    constructor(init) {
      headerLists.set(this, new Map());
      if (init === null || init === undefined) {
        return;
      }
      if (headerLists.has(init)) {
        for (const [name, value] of listHeaders(init)) {
          this.append(name, value);
        }
        return;
      }
      if (typeof init !== 'object') {
        throw new TypeError('Headers take a Headers, a list of pairs or a record');
      }
      if (typeof init[Symbol.iterator] === 'function') {
        for (const pair of init) {
          const [name, value, ...rest] = [...pair];
          if (value === undefined || rest.length > 0) {
            throw new TypeError('Each header is a pair of a name and a value');
          }
          this.append(name, value);
        }
        return;
      }
      for (const name of Object.keys(init)) {
        this.append(name, init[name]);
      }
    }
    append(name, value) {
      const key = toHeaderName(name);
      const text = toHeaderValue(value);
      const byName = readHeaders(this);
      byName.set(key, [...(byName.get(key) ?? []), text]);
    }
    delete(name) {
      readHeaders(this).delete(toHeaderName(name));
    }
    get(name) {
      return readHeaders(this).get(toHeaderName(name))?.join(', ') ?? null;
    }
    getSetCookie() {
      return [...(readHeaders(this).get('set-cookie') ?? [])];
    }
    has(name) {
      return readHeaders(this).has(toHeaderName(name));
    }
    set(name, value) {
      readHeaders(this).set(toHeaderName(name), [toHeaderValue(value)]);
    }
    *entries() {
      yield* listHeaders(this);
    }
    *keys() {
      for (const [name] of listHeaders(this)) {
        yield name;
      }
    }
    *values() {
      for (const [, value] of listHeaders(this)) {
        yield value;
      }
    }
    forEach(callback, thisArg) {
      for (const [name, value] of listHeaders(this)) {
        callback.call(thisArg, value, name, this);
      }
    }
  }
  Headers.prototype[Symbol.iterator] = Headers.prototype.entries;
  Object.defineProperty(Headers.prototype, Symbol.toStringTag, { value: 'Headers', configurable: true });

  function concatBytes(parts) {
    const joined = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
    let offset = 0;
    for (const part of parts) {
      joined.set(part, offset);
      offset += part.byteLength;
    }
    return joined;
  }

  function encodeFormData(form, boundary) {
    const parts = [];
    for (const [name, value] of form.entries()) {
      const escapedName = name.replace(/"/g, '%22').replace(/\\r\\n|\\r|\\n/g, '\\r\\n');
      const disposition = '--' + boundary + '\\r\\nContent-Disposition: form-data; name="' + escapedName + '"';
      if (value instanceof Blob) {
        const type = value.type || 'application/octet-stream';
        parts.push(encoder.encode(disposition + '; filename="blob"\\r\\nContent-Type: ' + type + '\\r\\n\\r\\n'));
        parts.push(readBlobBytes(value));
      } else {
        parts.push(encoder.encode(disposition + '\\r\\n\\r\\n'));
        parts.push(encoder.encode(value));
      }
      parts.push(encoder.encode('\\r\\n'));
    }
    parts.push(encoder.encode('--' + boundary + '--\\r\\n'));
    return concatBytes(parts);
  }

  // A copy of the body's bytes, which the request or response owns, and the content type the body implies.
  function extractBody(body) {
    if (typeof body === 'string') {
      return { bytes: encoder.encode(body), contentType: 'text/plain;charset=UTF-8' };
    }
    if (body instanceof Blob) {
      return { bytes: readBlobBytes(body).slice(), contentType: body.type || null };
    }
    if (body instanceof FormData) {
      const boundary = '----dotli-form-' + Math.random().toString(36).slice(2);
      return { bytes: encodeFormData(body, boundary), contentType: 'multipart/form-data; boundary=' + boundary };
    }
    if (body instanceof ArrayBuffer) {
      return { bytes: new Uint8Array(body).slice(), contentType: null };
    }
    if (ArrayBuffer.isView(body)) {
      return { bytes: new Uint8Array(body.buffer, body.byteOffset, body.byteLength).slice(), contentType: null };
    }
    throw new TypeError('A body is a string, a Blob, a FormData, an ArrayBuffer or a view of one');
  }

  // A request or response's body: \`bytes\` is null when it has none.
  const bodies = new WeakMap();

  function readBody(owner) {
    const body = bodies.get(owner);
    if (!body) {
      throw new TypeError('Illegal invocation');
    }
    return body;
  }

  function consumeBody(owner) {
    const body = readBody(owner);
    if (body.used) {
      throw new TypeError('The body has already been read');
    }
    if (body.bytes === null) {
      return new Uint8Array(0);
    }
    body.used = true;
    return body.bytes;
  }

  // Async, so a body read twice rejects rather than throws, as in a browser.
  const bodyMethods = {
    async arrayBuffer() {
      return consumeBody(this).slice().buffer;
    },
    async bytes() {
      return consumeBody(this).slice();
    },
    async text() {
      return decoder.decode(consumeBody(this));
    },
    async json() {
      return JSON.parse(decoder.decode(consumeBody(this)));
    },
    async blob() {
      return new Blob([consumeBody(this)], { type: this.headers.get('content-type') ?? '' });
    },
    async formData() {
      throw new TypeError('Reading a body as FormData is not supported');
    },
  };

  function defineBody(Owner) {
    for (const [name, method] of Object.entries(bodyMethods)) {
      Object.defineProperty(Owner.prototype, name, { value: method, writable: true, configurable: true });
    }
    Object.defineProperty(Owner.prototype, 'bodyUsed', {
      get() {
        return readBody(this).used;
      },
      configurable: true,
    });
  }

  function defineValues(target, values) {
    for (const [name, value] of Object.entries(values)) {
      Object.defineProperty(target, name, { value, enumerable: true });
    }
  }

  class Request {
    constructor(input, init = {}) {
      const source = input instanceof Request ? input : null;
      const options = init ?? {};
      const requested = String(options.method ?? source?.method ?? 'GET');
      const upper = requested.toUpperCase();
      if (FORBIDDEN_METHODS.includes(upper)) {
        throw new TypeError("Forbidden method '" + requested + "'");
      }
      const method = NORMALIZED_METHODS.includes(upper) ? upper : requested;
      const headers = new Headers(options.headers ?? source?.headers);
      let bytes = null;
      if (options.body !== undefined && options.body !== null) {
        const extracted = extractBody(options.body);
        bytes = extracted.bytes;
        if (extracted.contentType !== null && !headers.has('content-type')) {
          headers.set('content-type', extracted.contentType);
        }
      } else if (options.body === undefined && source) {
        const sourceBody = readBody(source);
        if (sourceBody.used) {
          throw new TypeError('The request body has already been read');
        }
        bytes = sourceBody.bytes?.slice() ?? null;
      }
      if (bytes !== null && (method === 'GET' || method === 'HEAD')) {
        throw new TypeError('A ' + method + ' request cannot have a body');
      }
      const signal = options.signal ?? source?.signal ?? new AbortController().signal;
      if (!(signal instanceof AbortSignal)) {
        throw new TypeError('A request signal is an AbortSignal');
      }
      defineValues(this, {
        url: source ? source.url : String(input),
        method,
        headers,
        signal,
        mode: options.mode ?? source?.mode ?? 'cors',
        credentials: options.credentials ?? source?.credentials ?? 'same-origin',
        cache: options.cache ?? source?.cache ?? 'default',
        redirect: options.redirect ?? source?.redirect ?? 'follow',
        referrer: String(options.referrer ?? source?.referrer ?? 'about:client'),
        referrerPolicy: options.referrerPolicy ?? source?.referrerPolicy ?? '',
        integrity: String(options.integrity ?? source?.integrity ?? ''),
        keepalive: Boolean(options.keepalive ?? source?.keepalive),
      });
      bodies.set(this, { bytes, used: false });
    }
    clone() {
      if (readBody(this).used) {
        throw new TypeError('A request whose body was read cannot be cloned');
      }
      return new Request(this);
    }
  }
  defineBody(Request);
  Object.defineProperty(Request.prototype, Symbol.toStringTag, { value: 'Request', configurable: true });

  function createResponse({ status, statusText, headers, bytes, url, type }) {
    const response = Object.create(Response.prototype);
    defineValues(response, {
      status,
      statusText,
      headers,
      ok: status >= 200 && status < 300,
      redirected: false,
      url,
      type,
    });
    bodies.set(response, { bytes, used: false });
    return response;
  }

  class Response {
    constructor(body = null, init = {}) {
      const options = init ?? {};
      const status = options.status === undefined ? 200 : Number(options.status);
      if (!Number.isInteger(status) || status < 200 || status > 599) {
        throw new RangeError('The status ' + String(options.status) + ' is not an integer from 200 to 599');
      }
      const headers = new Headers(options.headers);
      let bytes = null;
      if (body !== null && body !== undefined) {
        if (NULL_BODY_STATUSES.includes(status)) {
          throw new TypeError('A response with status ' + status + ' cannot have a body');
        }
        const extracted = extractBody(body);
        bytes = extracted.bytes;
        if (extracted.contentType !== null && !headers.has('content-type')) {
          headers.set('content-type', extracted.contentType);
        }
      }
      defineValues(this, {
        status,
        statusText: options.statusText === undefined ? '' : String(options.statusText),
        headers,
        ok: status >= 200 && status < 300,
        redirected: false,
        url: '',
        type: 'default',
      });
      bodies.set(this, { bytes, used: false });
    }
    clone() {
      const body = readBody(this);
      if (body.used) {
        throw new TypeError('A response whose body was read cannot be cloned');
      }
      return createResponse({
        status: this.status,
        statusText: this.statusText,
        headers: new Headers(this.headers),
        bytes: body.bytes?.slice() ?? null,
        url: this.url,
        type: this.type,
      });
    }
    static error() {
      return createResponse({ status: 0, statusText: '', headers: new Headers(), bytes: null, url: '', type: 'error' });
    }
    static redirect(url, status = 302) {
      if (!REDIRECT_STATUSES.includes(status)) {
        throw new RangeError('The redirect status ' + String(status) + ' is not 301, 302, 303, 307 or 308');
      }
      return new Response(null, { status, headers: { location: String(url) } });
    }
    static json(data, init = {}) {
      const headers = new Headers(init?.headers);
      if (!headers.has('content-type')) {
        headers.set('content-type', 'application/json');
      }
      return new Response(JSON.stringify(data), { ...init, headers });
    }
  }
  defineBody(Response);
  Object.defineProperty(Response.prototype, Symbol.toStringTag, { value: 'Response', configurable: true });

  let nextRequestId = 1;

  async function fetch(input, init) {
    const request = input instanceof Request && init === undefined ? input : new Request(input, init);
    const { signal } = request;
    signal.throwIfAborted();
    const body = readBody(request);
    if (body.used) {
      throw new TypeError('The request body has already been read');
    }
    // Sending reads the body, as in a browser.
    body.used = body.bytes !== null;
    const id = nextRequestId;
    nextRequestId += 1;
    const head = JSON.stringify({ method: request.method, url: request.url, headers: listHeaders(request.headers) });
    const sent = sendRequest(id, head, body.bytes ?? undefined);
    return new Promise((resolve, reject) => {
      function abort() {
        abortRequest(id);
        reject(signal.reason);
      }
      signal.addEventListener('abort', abort, { once: true });
      sent.then(
        ({ head, body }) => {
          signal.removeEventListener('abort', abort);
          const { status, statusText, headers, url } = JSON.parse(head);
          resolve(createResponse({ status, statusText, headers: new Headers(headers), bytes: body, url, type: 'basic' }));
        },
        error => {
          signal.removeEventListener('abort', abort);
          reject(error);
        },
      );
    });
  }

  globalThis.Headers = Headers;
  globalThis.Request = Request;
  globalThis.Response = Response;
  globalThis.fetch = fetch;
}`;

/**
 * Sets the VM's `fetch`, `Headers`, `Request` and `Response` on `fetch`. A request the VM aborts aborts the signal
 * `fetch` got, and the VM's `fetch` rejects with the abort's reason at once. A request body over `maxBodyBytes` rejects
 * with a `TypeError` before `fetch` hears of it.
 *
 * Throws when the VM cannot install them, or when the events, abort, text codecs and blob globals are not installed
 * first.
 */
export function createVmFetch({ vm, bytes, readBlobBytes, fetch, maxBodyBytes, onError }: Params) {
  const inFlight = new Map<number, InFlight>();

  const install = vm.unwrapResult(vm.evalCode(INSTALLER_SOURCE));
  const host = vm.newObject();
  try {
    defineVmFunctions(vm, host, {
      sendRequest(idHandle, headHandle, bodyHandle) {
        const id = vm.getNumber(idHandle);
        const head = parseHead(vm.getString(headHandle));
        const body = readRequestBody(bodyHandle);
        const controller = new AbortController();
        const deferred = vm.newPromise();
        inFlight.set(id, { controller, deferred });
        // Called outside the VM's call, so a fetch that throws rather than rejects still reaches the VM as a rejection.
        void Promise.resolve()
          .then(() => fetch({ ...head, body, signal: controller.signal }))
          .then(
            response => {
              settle(id, () => buildResponse(response), 'resolve');
            },
            (error: unknown) => {
              settle(id, () => buildError(error), 'reject');
            },
          );
        return deferred.handle;
      },
      abortRequest(idHandle) {
        // The VM has rejected its own fetch already, so the answer to this request is never awaited.
        const id = vm.getNumber(idHandle);
        const request = inFlight.get(id);
        inFlight.delete(id);
        request?.controller.abort();
        request?.deferred.dispose();
      },
    });
    vm.unwrapResult(vm.callFunction(install, vm.undefined, host, readBlobBytes)).dispose();
  } finally {
    host.dispose();
    install.dispose();
  }

  return {
    /** Aborts every request in flight and frees its promise, so no answer reaches the VM after it. Safe to repeat. */
    dispose() {
      for (const { controller, deferred } of inFlight.values()) {
        controller.abort();
        deferred.dispose();
      }
      inFlight.clear();
    },
  };

  /** Settles a request still in flight with the value `build` makes, then runs the jobs it queued. */
  function settle(id: number, build: () => QuickJSHandle, outcome: 'resolve' | 'reject'): void {
    const request = inFlight.get(id);
    if (!request) {
      return;
    }
    inFlight.delete(id);
    try {
      const value = build();
      request.deferred[outcome](value);
      value.dispose();
    } catch (error) {
      request.deferred.dispose();
      onError(new Error('A fetch response could not reach the VM', { cause: error }));
      return;
    }
    runVmJobs(vm, onError, 'a fetch');
  }

  /** The body's bytes, checking its size before the copy, since the cap bounds what the host allocates. */
  function readRequestBody(body: QuickJSHandle | undefined): Uint8Array | null {
    if (!body || vm.typeof(body) === 'undefined') {
      return null;
    }
    const lengthHandle = vm.getProp(body, 'byteLength');
    const length = vm.getNumber(lengthHandle);
    lengthHandle.dispose();
    if (length > maxBodyBytes) {
      throw new TypeError(`The fetch body of ${String(length)} bytes is over the cap of ${String(maxBodyBytes)}`);
    }
    return bytes.fromVm(body);
  }

  /** The VM's `{ head, body }` for a response. The caller disposes it. */
  function buildResponse({ status, statusText, headers, url, body }: HostFetchResponse): QuickJSHandle {
    const response = vm.newObject();
    const head = vm.newString(JSON.stringify({ status, statusText, headers, url }));
    vm.setProp(response, 'head', head);
    head.dispose();
    const bodyHandle = bytes.toVm(body);
    vm.setProp(response, 'body', bodyHandle);
    bodyHandle.dispose();
    return response;
  }

  /** The VM's error for a request that failed, keeping the name the host's fetch gave it, such as `TypeError`. */
  function buildError(error: unknown): QuickJSHandle {
    return error instanceof Error
      ? vm.newError({ name: error.name, message: error.message })
      : vm.newError(String(error));
  }
}

/**
 * The method, URL and headers of a request the VM's `fetch` sent.
 *
 * Throws when the JSON does not have that shape.
 */
function parseHead(json: string): Pick<HostFetchRequest, 'method' | 'url' | 'headers'> {
  const head: unknown = JSON.parse(json);
  if (!isRecord(head)) {
    throw new TypeError(`A fetch request from the VM is not an object: ${json}`);
  }
  const { method, url, headers } = head;
  if (typeof method !== 'string' || typeof url !== 'string' || !isHeaderList(headers)) {
    throw new TypeError(`A fetch request from the VM has an unknown shape: ${json}`);
  }
  return { method, url, headers };
}

function isHeaderList(value: unknown): value is [string, string][] {
  return (
    Array.isArray(value) &&
    value.every(
      (pair: unknown) =>
        Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string' && typeof pair[1] === 'string',
    )
  );
}
