// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal } from 'solid-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArchiveView } from '../../src/components/truapi-debug/ArchiveView.js';
import type { ArchiveLoader } from '../../src/components/truapi-debug/archive-source.js';
import { setProductLoaded } from '../../src/state/product.js';
import { renderComponent, resetStores, settle } from '../helpers/solid.js';
import { byTestId } from '../support.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
// "DOTLI_ENC\x01", the encrypted-SPA magic, then room for a salt, a nonce and a tag.
const ENCRYPTED = new Uint8Array([
  0x44,
  0x4f,
  0x54,
  0x4c,
  0x49,
  0x5f,
  0x45,
  0x4e,
  0x43,
  0x01,
  ...new Array<number>(60).fill(0),
]);

function view(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>('[data-testid="td-archive"]');
  if (el === null) {
    throw new Error('no archive view');
  }
  return el;
}

function fileButton(container: HTMLElement, path: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-testid="td-archive-file"][data-path="${path}"]`);
  if (el === null) {
    throw new Error(`no file ${path}`);
  }
  return el;
}

function content(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>('[data-testid="td-archive-content"]');
  if (el === null) {
    throw new Error('no content pane');
  }
  return el;
}

async function renderLoaded(
  files: Record<string, Uint8Array>,
): Promise<{ container: HTMLElement; load: ReturnType<typeof vi.fn<ArchiveLoader>> }> {
  setProductLoaded('myapp', 'myapp.dot', 'bafyroot');
  const load = vi.fn<ArchiveLoader>(() => Promise.resolve(files));
  const { container } = renderComponent(() => <ArchiveView active={true} load={load} />);
  await settle();
  await settle();
  return { container, load };
}

describe('ArchiveView', () => {
  afterEach(() => {
    resetStores();
    vi.restoreAllMocks();
  });

  it('As a dotli developer, the sidebar lists the archive files in order, with their count and sizes', async () => {
    // When
    const { container, load } = await renderLoaded({
      'index.html': enc('<h1>hi</h1>'),
      'assets/app.js': enc('run()'),
    });

    // Then
    expect(load).toHaveBeenCalledWith('bafyroot');
    const paths = [...container.querySelectorAll<HTMLElement>('[data-testid="td-archive-file"]')].map(
      el => el.dataset['path'],
    );
    expect(paths).toEqual(['assets/app.js', 'index.html']);
    expect(byTestId('td-archive-summary', view(container)).textContent).toContain('2 files');
    expect(fileButton(container, 'index.html').textContent).toContain('11 B');
  });

  it('As a dotli developer, selecting a text file shows its content', async () => {
    // Given
    const { container } = await renderLoaded({ 'index.html': enc('<h1>hi</h1>') });

    // When
    fileButton(container, 'index.html').click();
    await settle();

    // Then
    expect(fileButton(container, 'index.html').hasAttribute('data-active')).toBe(true);
    expect(content(container).querySelector('pre')?.textContent).toBe('<h1>hi</h1>');
  });

  it('As a dotli developer, selecting an image previews it, and leaving it frees the preview', async () => {
    // Given
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const { container } = await renderLoaded({ 'logo.png': new Uint8Array([0x89, 0x50]), 'a.txt': enc('a') });

    // When
    fileButton(container, 'logo.png').click();
    await settle();

    // Then
    expect(create).toHaveBeenCalledTimes(1);
    expect(content(container).querySelector('img')?.getAttribute('src')).toBe('blob:preview');

    // When
    fileButton(container, 'a.txt').click();
    await settle();

    // Then
    expect(revoke).toHaveBeenCalledWith('blob:preview');
  });

  it('As a dotli developer, a binary file shows its size instead of its bytes', async () => {
    // Given
    const { container } = await renderLoaded({ 'app.wasm': new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0xff]) });

    // When
    fileButton(container, 'app.wasm').click();
    await settle();

    // Then
    expect(content(container).textContent).toContain('Binary, 5 B');
    expect(content(container).querySelector('pre')).toBeNull();
  });

  it('As a dotli developer, an encrypted product says it is not decrypted', async () => {
    // Given
    const { container } = await renderLoaded({ 'index.html': ENCRYPTED });

    // When
    fileButton(container, 'index.html').click();
    await settle();

    // Then
    expect(content(container).textContent).toContain('Encrypted');
  });

  it('As a dotli developer, a failed read shows why', async () => {
    // Given
    setProductLoaded('myapp', 'myapp.dot', 'bafyroot');
    const load = vi.fn<ArchiveLoader>(() => Promise.reject(new Error('gateway 504')));

    // When
    const { container } = renderComponent(() => <ArchiveView active={true} load={load} />);
    await settle();
    await settle();

    // Then
    expect(view(container).textContent).toContain('gateway 504');
  });

  it('As a dotli developer on a local product, the tab says there is no archive', async () => {
    // Given
    setProductLoaded('localhost:5199', 'localhost:5199');
    const load = vi.fn<ArchiveLoader>();

    // When
    const { container } = renderComponent(() => <ArchiveView active={true} load={load} />);
    await settle();

    // Then
    expect(load).not.toHaveBeenCalled();
    expect(view(container).textContent).toContain('not served from a CID');
  });

  it('As a dotli developer, the archive is read once, when the tab first shows', async () => {
    // Given
    setProductLoaded('myapp', 'myapp.dot', 'bafyroot');
    const load = vi.fn<ArchiveLoader>(() => Promise.resolve({ 'index.html': enc('x') }));
    const [active, setActive] = createSignal(false);
    const { container } = renderComponent(() => <ArchiveView active={active()} load={load} />);
    await settle();

    // Then: hidden, nothing read yet
    expect(load).not.toHaveBeenCalled();
    expect(view(container).hidden).toBe(true);

    // When: shown, hidden, shown again
    setActive(true);
    await settle();
    setActive(false);
    await settle();
    setActive(true);
    await settle();

    // Then
    expect(load).toHaveBeenCalledTimes(1);
    expect(view(container).hidden).toBe(false);
  });
});
