// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { bindReports } from '../testing/bindReports.js';
import { createDevHttpChannel, readSharedSettings, writeSharedSettings, type SharedChannel } from './sharedMode.js';
import { createMemorySharedChannel } from './sharedMode.fake.js';

type FetchCall = { url: string; init: RequestInit };

type Params = {
  /** The HTTP status the local server answers every request with. */
  status: number;
  /** The body it answers with, empty by default. */
  body?: string;
};

const CACHE = JSON.stringify({ skipCidCache: true, skipArchiveCache: false, skipWorkerCache: false });
const ORIGIN = 'http://localhost:5173';
const KEY = 'dotli:chain-backend';
const KEY_URL = `${ORIGIN}/__dotli-mode/dotli%3Achain-backend`;

/** A local server that answers every request with `status` and `body`, and records each request. */
function createFakeFetch({ status, body = '' }: Params) {
  const calls: FetchCall[] = [];
  return {
    calls,
    /** Records the request and answers it. Never rejects. */
    fetch: answer,
  };

  function answer(url: string, init: RequestInit): Promise<Response> {
    calls.push({ url, init });
    return Promise.resolve(new Response(status === 204 ? null : body, { status }));
  }
}

describe('createDevHttpChannel', () => {
  it.each([
    { status: 200, body: 'rpc-gateway', stored: 'rpc-gateway' },
    { status: 200, body: '', stored: null },
    { status: 204, body: '', stored: null },
  ])(
    'As a developer on a local root, I read a shared setting the local server answers with $status "$body" and get $stored',
    async ({ status, body, stored }) => {
      // Given
      const server = createFakeFetch({ status, body });
      const channel = createDevHttpChannel({ origin: ORIGIN, fetch: server.fetch });

      // When
      const value = await channel.read(KEY);

      // Then
      expect(value).toBe(stored);
    },
  );

  it("As a developer on a local root, I read, write and clear a shared setting and each request reaches the local server's store under its key, uncached", async () => {
    // Given
    const server = createFakeFetch({ status: 200 });
    const channel = createDevHttpChannel({ origin: ORIGIN, fetch: server.fetch });

    // When
    await channel.read(KEY);
    await channel.write(KEY, 'rpc-gateway');
    await channel.clear(KEY);

    // Then
    expect(server.calls).toEqual([
      { url: KEY_URL, init: { cache: 'no-store' } },
      { url: KEY_URL, init: { method: 'PUT', body: 'rpc-gateway', cache: 'no-store' } },
      { url: KEY_URL, init: { method: 'DELETE', cache: 'no-store' } },
    ]);
  });

  it.each([
    { method: 'read', send: (channel: SharedChannel) => channel.read(KEY) },
    { method: 'write', send: (channel: SharedChannel) => channel.write(KEY, 'rpc-gateway') },
    { method: 'clear', send: (channel: SharedChannel) => channel.clear(KEY) },
  ])(
    'As a developer on a local root, I $method a shared setting the local server fails on and the call rejects with its status',
    async ({ method, send }) => {
      // Given
      const server = createFakeFetch({ status: 500 });
      const channel = createDevHttpChannel({ origin: ORIGIN, fetch: server.fetch });

      // When
      const sending = send(channel);

      // Then
      await expect(sending).rejects.toThrow(`mode sync ${method} ${KEY} failed with HTTP 500`);
    },
  );

  it('As a developer on a local root, I clear a shared setting the local server never held and the clear settles', async () => {
    // Given
    const server = createFakeFetch({ status: 404 });
    const channel = createDevHttpChannel({ origin: ORIGIN, fetch: server.fetch });

    // When
    const clearing = channel.clear(KEY);

    // Then
    await expect(clearing).resolves.toBeUndefined();
  });
});

describe('readSharedSettings', () => {
  it('As a visitor on a new subdomain, I read the backend and caches I chose elsewhere, and the read is counted', async () => {
    // Given
    const { counted } = bindReports();
    const store = createMemorySharedChannel({
      entries: { 'dotli:chain-backend': 'rpc-gateway', 'dotli:cache-settings': CACHE },
    });

    // When
    const shared = await readSharedSettings({ channel: store });

    // Then
    expect(shared).toEqual({ backend: 'rpc-gateway', cache: CACHE });
    expect(counted('shared_mode.read')).toEqual([{ outcome: 'ok' }]);
  });

  it('As an operator, I boot a page whose shared store cannot be read and get nothing from it, with the failure reported and counted', async () => {
    // Given
    const store = createMemorySharedChannel();
    store.readFails = true;
    const { captures, counted } = bindReports();

    // When
    const shared = await readSharedSettings({ channel: store });

    // Then
    expect(shared).toBeNull();
    expect(captures.exception).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'shared store unreachable' }),
      expect.objectContaining({
        step: 'shared_mode_read',
      }),
    );
    expect(counted('shared_mode.read')).toEqual([{ outcome: 'error', reason: 'Error' }]);
  });
});

describe('writeSharedSettings', () => {
  it('As a visitor, I save my backend and caches and they are mirrored for my other subdomains', async () => {
    // Given
    const store = createMemorySharedChannel();

    // When
    await writeSharedSettings({ backend: 'rpc-gateway', cache: CACHE }, { channel: store });

    // Then
    expect(store.writes).toEqual([
      ['dotli:chain-backend', 'rpc-gateway'],
      ['dotli:cache-settings', CACHE],
    ]);
  });

  it('As an operator, I save a shared setting that cannot be written and the save still settles, with the failure reported and counted', async () => {
    // Given
    const store = createMemorySharedChannel();
    store.writeFails = true;
    const { captures, counted } = bindReports();

    // When
    await writeSharedSettings({ backend: 'rpc-gateway', cache: null }, { channel: store });

    // Then
    expect(captures.exception).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'shared store unreachable' }),
      expect.objectContaining({
        step: 'shared_mode_write',
      }),
    );
    expect(counted('shared_mode.write')).toEqual([{ outcome: 'error', reason: 'Error' }]);
  });
});
