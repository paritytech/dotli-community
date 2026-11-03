// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { bindCaptureSink } from '@dotli/metrics';
import { createDeferred } from '@dotli/shared';
import { atom } from 'nanostores';
import type { PageUiModule } from './lazy.js';
import { createSandboxUi, type SandboxUi } from './createSandboxUi.js';

function createFakeUi(): PageUiModule {
  return {
    mountOverlays: vi.fn(),
    showError: vi.fn(),
    showRetryScreen: vi.fn(),
    createPasswordPromptView: vi.fn(),
  };
}

function createHarness(load: () => Promise<PageUiModule>, { queued = [] }: { queued?: readonly unknown[] } = {}) {
  const captures = { exception: vi.fn(), expected: vi.fn() };
  onTestFinished(bindCaptureSink(captures));
  const toasts = atom<{ items: readonly unknown[] }>({ items: queued });
  const texts: string[] = [];
  const hideFallback = vi.fn<() => void>();
  const ui: SandboxUi = createSandboxUi({ load, toasts, showFallback: text => texts.push(text), hideFallback });
  return { ui, toasts, texts, captures, hideFallback };
}

describe('sandbox UI', () => {
  it('As a visitor whose product loads, I open it and the sandbox never fetches its own UI', () => {
    // Given
    const load = vi.fn(() => Promise.resolve(createFakeUi()));

    // When
    createHarness(load);

    // Then
    expect(load).not.toHaveBeenCalled();
  });

  it('As a visitor, I get toasts before the UI is up and it loads and mounts once', async () => {
    // Given
    const module = createFakeUi();
    const load = vi.fn(() => Promise.resolve(module));
    const { ui, toasts } = createHarness(load);

    // When
    toasts.set({ items: ['reload offer'] });
    toasts.set({ items: ['reload offer', 'stale worker'] });
    await ui.loadUi();

    // Then
    expect(load).toHaveBeenCalledOnce();
    expect(module.mountOverlays).toHaveBeenCalledOnce();
  });

  it('As a visitor, I open the sandbox with a toast already queued and it still shows', async () => {
    // Given
    const module = createFakeUi();
    const load = vi.fn(() => Promise.resolve(module));

    // When
    const { ui } = createHarness(load, { queued: ['reload offer'] });
    await ui.loadUi();

    // Then
    expect(load).toHaveBeenCalledOnce();
    expect(module.mountOverlays).toHaveBeenCalledOnce();
  });

  it('As a visitor whose product page is written, I get a late toast or error and the sandbox UI never comes into the page', () => {
    // Given
    const load = vi.fn(() => Promise.resolve(createFakeUi()));
    const { ui, toasts, texts } = createHarness(load);
    ui.dispose();

    // When
    toasts.set({ items: ['stale worker'] });
    ui.showError('Late', 'failure');

    // Then
    expect(load).not.toHaveBeenCalled();
    expect(texts).toEqual([]);
  });

  it('As a visitor whose product page is written, I wait out a UI load in flight and it never mounts into the page', async () => {
    // Given
    const module = createFakeUi();
    const chunk = createDeferred<PageUiModule>();
    const { ui, toasts } = createHarness(() => chunk.promise);
    toasts.set({ items: ['stale worker'] });

    // When
    ui.dispose();
    chunk.resolve(module);
    await ui.loadUi();

    // Then
    expect(module.mountOverlays).not.toHaveBeenCalled();
  });

  it('As a visitor whose load failed, I wait for the UI and see the error page with its retry', async () => {
    // Given
    const module = createFakeUi();
    const { ui } = createHarness(() => Promise.resolve(module));
    const retry = vi.fn();

    // When
    ui.showError('Failed to load content', 'The network did not answer', { retry });
    await ui.loadUi();

    // Then
    expect(module.showError).toHaveBeenCalledWith('Failed to load content', {
      detail: 'The network did not answer',
      action: retry,
    });
  });

  it('As an operator, I watch the page UI fail to load under several screens and see the miss recorded once', async () => {
    // Given
    const { ui, captures } = createHarness(() => Promise.reject(new Error('chunk missing')));

    // When
    ui.showError('Failed to load content', 'The network did not answer');
    ui.showRetryScreen();
    await ui.loadUi().catch(() => undefined);

    // Then
    expect(captures.expected).toHaveBeenCalledOnce();
  });

  it('As a visitor whose network dropped, I get the failure text and a Reload button when the page UI cannot load', async () => {
    // Given
    const missing = new Error('chunk missing');
    const { ui, texts, captures } = createHarness(() => Promise.reject(missing));

    // When
    ui.showError('Failed to load content', 'The network did not answer');
    await ui.loadUi().catch(() => undefined);

    // Then
    expect(texts).toEqual(['Failed to load content. The network did not answer']);
    expect(captures.expected).toHaveBeenCalledWith(
      missing,
      expect.objectContaining({ flow: 'content', step: 'page_ui_load' }),
    );
  });

  it('As a visitor, I hit a second failure after the page UI failed to load and it loads again', async () => {
    // Given
    const module = createFakeUi();
    const load = vi.fn<() => Promise<PageUiModule>>();
    load.mockRejectedValueOnce(new Error('chunk missing'));
    load.mockResolvedValueOnce(module);
    const { ui, texts, captures } = createHarness(load);
    ui.showError('First', 'failure');
    await ui.loadUi().catch(() => undefined);

    // When
    ui.showError('Second', 'failure');
    await ui.loadUi();

    // Then
    expect(load).toHaveBeenCalledTimes(2);
    expect(texts).toEqual(['First. failure']);
    expect(module.showError).toHaveBeenCalledWith('Second', { detail: 'failure', action: undefined });
    expect(captures.expected).toHaveBeenCalledOnce();
  });

  it('As a visitor shown the fallback screen, I hit a later failure and the page UI that loads then takes the screen away', async () => {
    // Given
    const load = vi.fn<() => Promise<PageUiModule>>();
    load.mockRejectedValueOnce(new Error('chunk missing'));
    load.mockResolvedValueOnce(createFakeUi());
    const { ui, texts, hideFallback } = createHarness(load);
    ui.showError('First', 'failure');
    await ui.loadUi().catch(() => undefined);

    // When
    ui.showError('Second', 'failure');
    await ui.loadUi();

    // Then the first failure showed on the fallback screen, which the loaded UI then took away
    expect(texts).toEqual(['First. failure']);
    expect(hideFallback).toHaveBeenCalledOnce();
  });

  it('As a visitor, I get a retry screen while the UI cannot load and it still offers Reload', async () => {
    // Given
    const { ui, texts } = createHarness(() => Promise.reject(new Error('chunk missing')));

    // When
    ui.showRetryScreen();
    await ui.loadUi().catch(() => undefined);

    // Then
    expect(texts).toEqual(['Failed to load content.']);
  });

  it('As a visitor whose product page is written, I stay on it and no sandbox failure draws into it, even from a load in flight', async () => {
    // Given
    const module = createFakeUi();
    const chunk = createDeferred<PageUiModule>();
    const { ui, texts } = createHarness(() => chunk.promise);
    ui.showError('Late', 'failure');
    ui.showRetryScreen();

    // When
    ui.dispose();
    chunk.reject(new Error('chunk missing'));
    await ui.loadUi().catch(() => undefined);

    // Then
    expect(texts).toEqual([]);
    expect(module.showError).not.toHaveBeenCalled();
  });

  it('As a visitor whose product page is written, I stay on it and a UI load that resolves late draws no error', async () => {
    // Given
    const module = createFakeUi();
    const chunk = createDeferred<PageUiModule>();
    const { ui } = createHarness(() => chunk.promise);
    ui.showError('Late', 'failure');

    // When
    ui.dispose();
    chunk.resolve(module);
    await ui.loadUi();

    // Then
    expect(module.showError).not.toHaveBeenCalled();
  });
});
