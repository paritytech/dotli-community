// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchResult } from '@dotli/content';
import type * as ConfigModule from '@dotli/config';
import { createRendererImageLoader } from '../src/chat/service.js';

const content = vi.hoisted(() => ({
  fetchArchive: vi.fn<() => Promise<FetchResult>>(),
}));
vi.mock('@dotli/content', () => ({
  loadFetch: () => Promise.resolve({ fetchArchive: content.fetchArchive }),
  bitswapGet: vi.fn(),
}));
vi.mock('@dotli/config', async original => ({
  ...(await original<typeof ConfigModule>()),
  getBackend: () => 'rpc-gateway',
}));
beforeEach(() => {
  content.fetchArchive.mockReset();
});

describe('renderer image sources', () => {
  it('selects literal archive paths from the launched executable and shares one fetch per tree', async () => {
    const bytes = new TextEncoder();
    content.fetchArchive.mockResolvedValue({
      type: 'archive',
      files: {
        'assets/icon.svg': bytes.encode('<svg/>'),
        'assets/icon.png': bytes.encode('png bytes'),
      },
    });
    const load = createRendererImageLoader('launched-archive');
    const controller = new AbortController();
    const [svg, png] = await Promise.all([
      load({ tag: 'Archive', value: 'assets/icon.svg' }, controller.signal),
      load({ tag: 'Archive', value: 'assets/icon.png' }, controller.signal),
    ]);
    expect(await svg.text()).toBe('<svg/>');
    expect(svg.type).toBe('image/svg+xml');
    expect(await png.text()).toBe('png bytes');
    expect(png.type).toBe('image/png');
    expect(content.fetchArchive).toHaveBeenCalledTimes(1);
    expect(content.fetchArchive).toHaveBeenCalledWith('launched-archive', undefined, { useGateway: true });
    controller.abort();
    await load({ tag: 'Archive', value: 'assets/icon.png' }, new AbortController().signal);
    expect(content.fetchArchive).toHaveBeenCalledTimes(2);
  });

  it.each(['', '/icon.png', '../icon.png', 'a/../icon.png', './icon.png', 'a//icon.png', 'a\\icon.png', 'a\u0000.png'])(
    'rejects ambiguous archive path %j before fetching',
    async path => {
      await expect(
        createRendererImageLoader('archive')({ tag: 'Archive', value: path }, new AbortController().signal),
      ).rejects.toBeInstanceOf(Error);
      expect(content.fetchArchive).not.toHaveBeenCalled();
    },
  );

  it('never uses inherited archive entries or substitutes a different file for a missing image', async () => {
    content.fetchArchive.mockResolvedValue({ type: 'archive', files: { 'icon.png': new Uint8Array([1]) } });
    const load = createRendererImageLoader('archive');
    const signal = new AbortController().signal;
    await expect(load({ tag: 'Archive', value: 'toString' }, signal)).rejects.toBeInstanceOf(Error);
    await expect(load({ tag: 'Archive', value: 'missing.png' }, signal)).rejects.toBeInstanceOf(Error);
  });

  it('requires a launched archive for archive images', async () => {
    await expect(
      createRendererImageLoader()({ tag: 'Archive', value: 'icon.png' }, new AbortController().signal),
    ).rejects.toBeInstanceOf(Error);
    expect(content.fetchArchive).not.toHaveBeenCalled();
  });

  it('loads Bulletin bytes independently of the archive and identifies filename-less SVG', async () => {
    content.fetchArchive.mockResolvedValue({ type: 'single', content: new TextEncoder().encode('  <svg/>') });
    const blob = await createRendererImageLoader('archive')(
      { tag: 'Bulletin', value: 'image-cid' },
      new AbortController().signal,
    );
    expect(blob.type).toBe('image/svg+xml');
    expect(await blob.text()).toBe('  <svg/>');
    expect(content.fetchArchive).toHaveBeenCalledWith('image-cid', undefined, { useGateway: true });
  });

  it('rejects a Bulletin directory rather than choosing an arbitrary file', async () => {
    content.fetchArchive.mockResolvedValue({ type: 'archive', files: { 'icon.png': new Uint8Array([1]) } });
    await expect(
      createRendererImageLoader()({ tag: 'Bulletin', value: 'directory' }, new AbortController().signal),
    ).rejects.toBeInstanceOf(Error);
  });

  it('does not publish image bytes from a fetch that finishes after disposal', async () => {
    let resolve: (result: FetchResult) => void = () => {
      throw new Error('fetch not started');
    };
    content.fetchArchive.mockReturnValue(
      new Promise<FetchResult>(done => {
        resolve = done;
      }),
    );
    const controller = new AbortController();
    const pending = createRendererImageLoader()({ tag: 'Bulletin', value: 'image' }, controller.signal);
    await Promise.resolve();
    controller.abort();
    resolve({ type: 'single', content: new Uint8Array([1]) });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
