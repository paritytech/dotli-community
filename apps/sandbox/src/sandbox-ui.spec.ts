// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { bindCaptureSink } from '@dotli/metrics';
import { createSyncStore } from '@dotli/shared';
import type { PageUiModule } from './lazy.js';
import { createSandboxUi } from './sandbox-ui.js';

function fakeUi(): PageUiModule {
  return {
    mountOverlays: vi.fn(),
    showError: vi.fn(),
    showRetryScreen: vi.fn(),
    passwordPromptDialog: vi.fn(),
  };
}

function setup(load: () => Promise<PageUiModule>, queued: readonly unknown[] = []) {
  const captures = { exception: vi.fn(), expected: vi.fn() };
  onTestFinished(bindCaptureSink(captures));
  const toasts = createSyncStore<{ items: readonly unknown[] }>('test-toasts', { items: queued });
  const texts: string[] = [];
  const hideFallback = vi.fn<() => void>();
  const ui = createSandboxUi({ load, toasts, showFallback: text => texts.push(text), hideFallback });
  return { ui, toasts, texts, captures, hideFallback };
}

describe('sandbox UI', () => {
  it('As a visitor whose product loads, the sandbox never fetches its own UI', () => {
    // Given
    const load = vi.fn(() => Promise.resolve(fakeUi()));

    // When
    setup(load);

    // Then
    expect(load).not.toHaveBeenCalled();
  });

  it('As a visitor, a toast raised before the UI is up makes it load and mount once', async () => {
    // Given
    const module = fakeUi();
    const load = vi.fn(() => Promise.resolve(module));
    const { ui, toasts } = setup(load);

    // When
    toasts.set({ items: ['reload offer'] });
    toasts.set({ items: ['reload offer', 'stale worker'] });
    await ui.ready();

    // Then
    expect(load).toHaveBeenCalledOnce();
    expect(module.mountOverlays).toHaveBeenCalledOnce();
  });

  it('As a visitor, a toast queued before the UI existed still shows', async () => {
    // Given
    const module = fakeUi();
    const load = vi.fn(() => Promise.resolve(module));

    // When
    const { ui } = setup(load, ['reload offer']);
    await ui.ready();

    // Then
    expect(load).toHaveBeenCalledOnce();
    expect(module.mountOverlays).toHaveBeenCalledOnce();
  });

  it('As a product, a toast raised after my page is written never brings the sandbox UI into it', () => {
    // Given
    const load = vi.fn(() => Promise.resolve(fakeUi()));
    const { ui, toasts, texts } = setup(load);
    ui.close();

    // When
    toasts.set({ items: ['stale worker'] });
    ui.showError('Late', 'failure');

    // Then
    expect(load).not.toHaveBeenCalled();
    expect(texts).toEqual([]);
  });

  it('As a product, a UI load still in flight when my page is written never mounts into it', async () => {
    // Given
    const module = fakeUi();
    let resolve: (ui: PageUiModule) => void = () => undefined;
    const promise = new Promise<PageUiModule>(done => {
      resolve = done;
    });
    const { ui, toasts } = setup(() => promise);
    toasts.set({ items: ['stale worker'] });

    // When
    ui.close();
    resolve(module);
    await ui.ready();

    // Then
    expect(module.mountOverlays).not.toHaveBeenCalled();
  });

  it('As a visitor whose load failed, I see the error page with its retry', async () => {
    // Given
    const module = fakeUi();
    const { ui } = setup(() => Promise.resolve(module));
    const retry = vi.fn();

    // When
    ui.showError('Failed to load content', 'The network did not answer', retry);
    await ui.ready();

    // Then
    expect(module.showError).toHaveBeenCalledWith('Failed to load content', 'The network did not answer', retry);
  });

  it('As a visitor whose page UI cannot load, the miss is counted once however many screens wait on it', async () => {
    // Given
    const { ui, captures } = setup(() => Promise.reject(new Error('chunk missing')));

    // When
    ui.showError('Failed to load content', 'The network did not answer');
    ui.showRetryScreen();
    await ui.ready().catch(() => undefined);

    // Then
    expect(captures.expected).toHaveBeenCalledOnce();
  });

  it('As a visitor whose network dropped, I get the failure text and a Reload button when the page UI cannot load', async () => {
    // Given
    const missing = new Error('chunk missing');
    const { ui, texts, captures } = setup(() => Promise.reject(missing));

    // When
    ui.showError('Failed to load content', 'The network did not answer');
    await ui.ready().catch(() => undefined);

    // Then
    expect(texts).toEqual(['Failed to load content. The network did not answer']);
    expect(captures.expected).toHaveBeenCalledWith(
      missing,
      expect.objectContaining({ flow: 'content', step: 'page_ui_load' }),
    );
  });

  it('As a visitor, a failure after the page UI failed to load tries to load it again', async () => {
    // Given
    const module = fakeUi();
    const load = vi.fn<() => Promise<PageUiModule>>();
    load.mockRejectedValueOnce(new Error('chunk missing'));
    load.mockResolvedValueOnce(module);
    const { ui, texts, captures } = setup(load);
    ui.showError('First', 'failure');
    await ui.ready().catch(() => undefined);

    // When
    ui.showError('Second', 'failure');
    await ui.ready();

    // Then
    expect(load).toHaveBeenCalledTimes(2);
    expect(texts).toEqual(['First. failure']);
    expect(module.showError).toHaveBeenCalledWith('Second', 'failure', undefined);
    expect(captures.expected).toHaveBeenCalledOnce();
  });

  it('As a visitor shown the fallback screen, a later page UI load that succeeds takes it away', async () => {
    // Given
    const load = vi.fn<() => Promise<PageUiModule>>();
    load.mockRejectedValueOnce(new Error('chunk missing'));
    load.mockResolvedValueOnce(fakeUi());
    const { ui, texts, hideFallback } = setup(load);
    ui.showError('First', 'failure');
    await ui.ready().catch(() => undefined);
    expect(texts).toEqual(['First. failure']);

    // When
    ui.showError('Second', 'failure');
    await ui.ready();

    // Then
    expect(hideFallback).toHaveBeenCalledOnce();
  });

  it('As a visitor, a retry screen asked for while the UI cannot load still offers Reload', async () => {
    // Given
    const { ui, texts } = setup(() => Promise.reject(new Error('chunk missing')));

    // When
    ui.showRetryScreen();
    await ui.ready().catch(() => undefined);

    // Then
    expect(texts).toEqual(['Failed to load content.']);
  });

  it('As a product, no sandbox failure draws into my page once it is written, even from a load in flight', async () => {
    // Given
    const module = fakeUi();
    let reject: (err: Error) => void = () => undefined;
    const failing = new Promise<PageUiModule>((_, fail) => {
      reject = fail;
    });
    const { ui, texts } = setup(() => failing);
    ui.showError('Late', 'failure');
    ui.showRetryScreen();

    // When
    ui.close();
    reject(new Error('chunk missing'));
    await ui.ready().catch(() => undefined);

    // Then
    expect(texts).toEqual([]);
    expect(module.showError).not.toHaveBeenCalled();
  });

  it('As a product, a load in flight that resolves after my page is written draws no error', async () => {
    // Given
    const module = fakeUi();
    let resolve: (ui: PageUiModule) => void = () => undefined;
    const pending = new Promise<PageUiModule>(done => {
      resolve = done;
    });
    const { ui } = setup(() => pending);
    ui.showError('Late', 'failure');

    // When
    ui.close();
    resolve(module);
    await ui.ready();

    // Then
    expect(module.showError).not.toHaveBeenCalled();
  });
});
