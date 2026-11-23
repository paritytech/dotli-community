// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';

import type { HostFetchRequest, HostFetchResponse } from './createVmFetch.js';
import { startVm } from './testing/startVm.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe('createVmFetch', () => {
  it('As a module, I fetch through the host and read its response body as text and as bytes', async () => {
    // Given
    const host = createFakeFetch(() =>
      Promise.resolve({
        status: 201,
        statusText: 'Created',
        headers: [['content-type', 'text/plain']],
        body: encoder.encode('pong'),
        url: 'https://api.example/items/1',
      }),
    );
    const { vm, untilLogged, readMessages } = await startVm(
      {
        'main.js': `const response = await fetch('https://api.example/items', {
            method: 'post',
            headers: { 'X-Trace': 'a' },
            body: 'ping',
          });
          const copy = response.clone();
          console.log(String(response.status), response.statusText, response.url, response.headers.get('content-type'));
          console.log(await response.text(), [...(await copy.bytes())].join(','));`,
      },
      { fetch: host.fetch },
    );

    // When
    await vm.run();
    await untilLogged(2);

    // Then
    expect({ requests: host.readRequests(), messages: readMessages() }).toEqual({
      requests: [
        {
          method: 'POST',
          url: 'https://api.example/items',
          headers: [
            ['content-type', 'text/plain;charset=UTF-8'],
            ['x-trace', 'a'],
          ],
          body: 'ping',
        },
      ],
      messages: ['201 Created https://api.example/items/1 text/plain', 'pong 112,111,110,103'],
    });
  });

  it('As a module, I see my fetch reject with the name and message the host rejected with', async () => {
    // Given
    const host = createFakeFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    const { vm, untilLogged, readMessages } = await startVm(
      {
        'main.js': `fetch('https://down.example/').catch(error => console.log(error.name + ': ' + error.message));`,
      },
      { fetch: host.fetch },
    );

    // When
    await vm.run();
    await untilLogged(1);

    // Then
    expect(readMessages()).toEqual(['TypeError: Failed to fetch']);
  });

  it('As a module, I abort a fetch in flight, which aborts the host request and rejects with an AbortError', async () => {
    // Given
    const host = createFakeFetch(() => new Promise<HostFetchResponse>(() => undefined));
    const { vm, timers, untilLogged, readMessages } = await startVm(
      {
        'main.js': `const controller = new AbortController();
          fetch('https://slow.example/', { signal: controller.signal }).catch(error => console.log(error.name));
          setTimeout(() => controller.abort(), 10);`,
      },
      { fetch: host.fetch },
    );
    await vm.run();
    const request = await host.untilRequested();

    // When
    await timers.advance(10);
    await untilLogged(1);

    // Then
    expect({ aborted: request.signal.aborted, messages: readMessages() }).toEqual({
      aborted: true,
      messages: ['AbortError'],
    });
  });

  it('As a module, I time out a fetch with AbortSignal.timeout and see it reject with a TimeoutError', async () => {
    // Given
    const host = createFakeFetch(() => new Promise<HostFetchResponse>(() => undefined));
    const { vm, timers, untilLogged, readMessages } = await startVm(
      {
        'main.js': `fetch('https://slow.example/', { signal: AbortSignal.timeout(50) })
          .catch(error => console.log(error.name));`,
      },
      { fetch: host.fetch },
    );
    await vm.run();

    // When
    await timers.advance(50);
    await untilLogged(1);

    // Then
    expect(readMessages()).toEqual(['TimeoutError']);
  });

  it('As a module, I send a body over the cap, and my fetch rejects without reaching the host', async () => {
    // Given
    const host = createFakeFetch(() => Promise.reject(new Error('The host was reached')));
    const { vm, untilLogged, readMessages } = await startVm(
      {
        'main.js': `fetch('https://api.example/', { method: 'POST', body: 'hello' }).catch(error => console.log(error.name));`,
      },
      { fetch: host.fetch, maxFetchBodyBytes: 4 },
    );

    // When
    await vm.run();
    await untilLogged(1);

    // Then
    expect({ requests: host.readRequests(), messages: readMessages() }).toEqual({
      requests: [],
      messages: ['TypeError'],
    });
  });

  it('As a module run with no host fetch, I find no fetch', async () => {
    // Given
    const { vm, readMessages } = await startVm({ 'main.js': `console.log(typeof fetch);` });

    // When
    await vm.run();

    // Then
    expect(readMessages()).toEqual(['undefined']);
  });

  it('As a module, I send a Blob body, which reaches the host as bytes with its type', async () => {
    // Given
    const host = createFakeFetch(answerEmpty);
    const { vm } = await startVm(
      {
        'main.js': `await fetch('https://api.example/', {
            method: 'PUT',
            body: new Blob(['a', new Uint8Array([98])], { type: 'Text/Plain' }),
          });`,
      },
      { fetch: host.fetch },
    );

    // When
    await vm.run();

    // Then
    expect(host.readRequests().map(({ headers, body }) => ({ headers, body }))).toEqual([
      { headers: [['content-type', 'text/plain']], body: 'ab' },
    ]);
  });

  it('As a module, I send a FormData body, which reaches the host as multipart bytes with its boundary', async () => {
    // Given
    const host = createFakeFetch(answerEmpty);
    const { vm } = await startVm(
      {
        'main.js': `const form = new FormData();
          form.append('name', 'dot');
          form.append('file', new Blob(['xyz'], { type: 'text/plain' }));
          await fetch('https://api.example/', { method: 'POST', body: form });`,
      },
      { fetch: host.fetch },
    );

    // When
    await vm.run();

    // Then
    const [request] = host.readRequests();
    const boundary = /^multipart\/form-data; boundary=(.+)$/.exec(request?.headers[0]?.[1] ?? '')?.[1] ?? '';
    expect({ boundary, body: request?.body }).toEqual({
      boundary: expect.stringMatching(/.+/) as unknown,
      body: [
        `--${boundary}`,
        'Content-Disposition: form-data; name="name"',
        '',
        'dot',
        `--${boundary}`,
        'Content-Disposition: form-data; name="file"; filename="blob"',
        'Content-Type: text/plain',
        '',
        'xyz',
        `--${boundary}--`,
        '',
      ].join('\r\n'),
    });
  });

  it('As a host, I dispose the VM, and every request in flight is aborted', async () => {
    // Given
    const host = createFakeFetch(() => new Promise<HostFetchResponse>(() => undefined));
    const { vm } = await startVm(
      { 'main.js': `fetch('https://slow.example/').catch(() => undefined);` },
      { fetch: host.fetch },
    );
    await vm.run();
    const request = await host.untilRequested();

    // When
    vm.dispose();

    // Then
    expect(request.signal.aborted).toBe(true);
  });
});

/**
 * A host fetch that answers each request with `answer`, and records what it got, with each body as text.
 */
function createFakeFetch(answer: (request: HostFetchRequest) => Promise<HostFetchResponse>) {
  const requests: HostFetchRequest[] = [];
  const waiters: ((request: HostFetchRequest) => void)[] = [];

  return { fetch: fetchRequest, readRequests, untilRequested };

  function fetchRequest(request: HostFetchRequest): Promise<HostFetchResponse> {
    requests.push(request);
    for (const resolve of waiters.splice(0)) {
      resolve(request);
    }
    return answer(request);
  }

  /** The requests so far, with the signal left out and each body as text. */
  function readRequests() {
    return requests.map(({ method, url, headers, body }) => ({
      method,
      url,
      headers,
      body: body && decoder.decode(body),
    }));
  }

  /** Resolves with the first request, once the host has it. */
  function untilRequested(): Promise<HostFetchRequest> {
    const [first] = requests;
    return first ? Promise.resolve(first) : new Promise(resolve => waiters.push(resolve));
  }
}

function answerEmpty(request: HostFetchRequest): Promise<HostFetchResponse> {
  return Promise.resolve({
    status: 204,
    statusText: 'No Content',
    headers: [],
    body: new Uint8Array(0),
    url: request.url,
  });
}
