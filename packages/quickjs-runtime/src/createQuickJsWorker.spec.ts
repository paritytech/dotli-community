// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';

import type { QuickJsWorkerParams } from './createQuickJsWorker.js';
import { createQuickJsWorker } from './createQuickJsWorker.js';
import type { ConsoleLevel } from './installConsole.js';
import { QuickJsVmError } from './quickJsVmError.js';
import { serveQuickJsWorker } from './serveQuickJsWorker.js';

type Options = {
  isHostAllowed?: QuickJsWorkerParams['isHostAllowed'];
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  crypto?: Crypto;
};

describe('createQuickJsWorker', () => {
  it("As a page, I post bytes to a worker's VM and hear its reply on the wire", async () => {
    // Given
    const { worker } = startWorker({
      'main.js': `__HOST_API_PORT__.addEventListener('message', event => {
        __HOST_API_PORT__.postMessage(event.data.map(byte => byte * 2));
      });`,
    });
    await worker.run;
    const reply = readNextMessage(worker.wire);

    // When
    worker.wire.postMessage(new Uint8Array([4, 5]));

    // Then
    expect(await reply).toEqual(new Uint8Array([8, 10]));
  });

  it("As a page, I let a worker's VM fetch a host I allow, and the request goes out with credentials omitted", async () => {
    // Given
    const asked: string[] = [];
    const requests: { url: string; credentials: RequestCredentials | undefined }[] = [];
    const { worker, logs } = startWorker(
      {
        'main.js': `const response = await fetch('https://api.example:8443/data');
          console.log(response.status, await response.text());`,
      },
      {
        isHostAllowed: host => {
          asked.push(host);
          return Promise.resolve(true);
        },
        fetch: (url, init) => {
          requests.push({ url, credentials: init.credentials });
          return Promise.resolve(new Response('hello'));
        },
      },
    );

    // When
    await worker.run;

    // Then
    expect(asked).toEqual(['api.example:8443']);
    expect(requests).toEqual([{ url: 'https://api.example:8443/data', credentials: 'omit' }]);
    expect(logs).toEqual([{ level: 'log', message: '200 hello' }]);
  });

  it("As a page, I deny a host, and the VM's fetch of it answers 403 with no request going out", async () => {
    // Given
    const requests: string[] = [];
    const { worker, logs } = startWorker(
      { 'main.js': `console.log((await fetch('https://tracker.example/')).status);` },
      {
        isHostAllowed: () => Promise.resolve(false),
        fetch: url => {
          requests.push(url);
          return Promise.resolve(new Response('tracked'));
        },
      },
    );

    // When
    await worker.run;

    // Then
    expect(requests).toEqual([]);
    expect(logs).toEqual([{ level: 'log', message: '403' }]);
  });

  it("As a page whose host check rejects, I see the VM's fetch answer 403 and hear the failure", async () => {
    // Given
    const requests: string[] = [];
    const { worker, logs, errors } = startWorker(
      { 'main.js': `console.log((await fetch('https://api.example/')).status);` },
      {
        isHostAllowed: () => Promise.reject(new Error('grants unreadable')),
        fetch: url => {
          requests.push(url);
          return Promise.resolve(new Response('data'));
        },
      },
    );

    // When
    await worker.run;

    // Then
    expect(requests).toEqual([]);
    expect(logs).toEqual([{ level: 'log', message: '403' }]);
    expect(errors.map(error => error.message)).toEqual([expect.stringMatching(/'api\.example'/)]);
  });

  it.each([
    ['a relative URL', '/data'],
    ['a URL of another scheme', 'file:///etc/hosts'],
  ])("As a page, I am not asked about a VM's fetch of %s, which rejects", async (_case, url) => {
    // Given
    const asked: string[] = [];
    const { worker, logs } = startWorker(
      { 'main.js': `await fetch('${url}').catch(error => console.log(error.name, error.message));` },
      {
        isHostAllowed: host => {
          asked.push(host);
          return Promise.resolve(true);
        },
      },
    );

    // When
    await worker.run;

    // Then
    expect(asked).toEqual([]);
    expect(logs).toEqual([
      { level: 'log', message: `TypeError Only an absolute http or https URL may be fetched, not '${url}'` },
    ]);
  });

  it("As a page, I see a worker's VM draw its random values from the WebCrypto the worker serves with", async () => {
    // Given
    const sevens: Crypto = {
      subtle: globalThis.crypto.subtle,
      randomUUID: () => globalThis.crypto.randomUUID(),
      getRandomValues: array => {
        new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(7);
        return array;
      },
    };
    const { worker, logs } = startWorker(
      { 'main.js': `console.log(crypto.getRandomValues(new Uint8Array(3)).join());` },
      { crypto: sevens },
    );

    // When
    await worker.run;

    // Then
    expect(logs).toEqual([{ level: 'log', message: '7,7,7' }]);
  });

  it("As a page, I see a worker's run end with the error its entrypoint throws", async () => {
    // Given
    const { worker } = startWorker({ 'main.js': `throw new TypeError('broken worker');` });

    // When
    const error = await worker.run.catch((reason: unknown) => reason);

    // Then
    expect(error).toBeInstanceOf(QuickJsVmError);
    expect(error).toHaveProperty('message', expect.stringMatching(/TypeError: broken worker/));
  });

  it("As a page, I see a worker's error event end its run as a failure and terminate the worker", async () => {
    // Given
    const { worker, target, getTerminations } = startWorker({ 'main.js': '' });

    // When
    target.dispatchEvent(new Event('error'));

    // Then
    await expect(worker.run).rejects.toThrow(/The QuickJS worker failed/);
    expect(getTerminations()).toBe(1);
  });

  it('As a page, I dispose a worker twice, and it is terminated once', async () => {
    // Given
    const { worker, getTerminations } = startWorker({ 'main.js': '' });
    await worker.run;

    // When
    worker.dispose();
    worker.dispose();

    // Then
    expect(getTerminations()).toBe(1);
  });
});

/**
 * A worker client over `sources`, whose worker serves on a message channel in this thread, as the worker entry does
 * on its own scope. Terminating it stops serving. It is disposed when the test finishes.
 */
function startWorker(sources: Record<string, string>, { isHostAllowed, fetch, crypto }: Options = {}) {
  const encoder = new TextEncoder();
  const channel = new MessageChannel();
  const served = serveQuickJsWorker({
    scope: channel.port2,
    fetch: fetch ?? rejectFetch,
    crypto: crypto ?? globalThis.crypto,
  });
  const logs: { level: ConsoleLevel; message: string }[] = [];
  const errors: Error[] = [];
  let terminations = 0;
  const target = Object.assign(new EventTarget(), {
    postMessage(message: unknown, transfer: Transferable[]) {
      channel.port1.postMessage(message, transfer);
    },
    terminate() {
      terminations += 1;
      served.dispose();
      channel.port1.close();
    },
  });
  const worker = createQuickJsWorker({
    createWorker: () => target,
    files: new Map(Object.entries(sources).map(([path, source]) => [path, encoder.encode(source)])),
    entrypoint: 'main.js',
    isHostAllowed: isHostAllowed ?? (() => Promise.resolve(false)),
    onConsole(level, message) {
      logs.push({ level, message });
    },
    onError(error) {
      errors.push(error);
    },
  });
  onTestFinished(() => {
    worker.dispose();
  });

  return { worker, target, logs, errors, getTerminations: () => terminations };
}

function rejectFetch(url: string): Promise<Response> {
  return Promise.reject(new Error(`No request may go out in this test: ${url}`));
}

function readNextMessage(port: MessagePort): Promise<unknown> {
  return new Promise(resolve => {
    port.addEventListener('message', event => resolve(event.data), { once: true });
    port.start();
  });
}
