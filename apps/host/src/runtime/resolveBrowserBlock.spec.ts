// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { BrowserPermissions, BrowserPermissionStatus } from './createBrowserPermissions.js';
import { createFakePrompts, type FakePrompt, type FakePrompts } from './hostPrompts.fake.js';
import type { EnforceablePermissionName } from './permissionPolicy.js';
import { resolveBrowserBlock, type BrowserBlockResolution } from './resolveBrowserBlock.js';
import type { ProductPermissions } from './state/productPermissions.js';

type FakeBrowser = {
  read: Mock<BrowserPermissions['read']>;
  request: Mock<BrowserPermissions['request']>;
};

const LABEL = 'myapp';

let page: FakePrompts;
let browserStatus: BrowserPermissionStatus;
let browser: FakeBrowser;
let controller: AbortController;
let record: Mock<ProductPermissions['recordPromptDecision']>;

beforeEach(() => {
  page = createFakePrompts();
  browserStatus = 'denied';
  browser = {
    read: vi.fn<BrowserPermissions['read']>(() => Promise.resolve(browserStatus)),
    request: vi.fn<BrowserPermissions['request']>(() => null),
  };
  controller = new AbortController();
  record = vi.fn<ProductPermissions['recordPromptDecision']>(() => Promise.resolve());
});

describe('resolveBrowserBlock', () => {
  it('As a dotli user, I restrict a blocked permission and a denial is stored for the app', async () => {
    // Given the blocked dialog on screen
    const { resolution } = await showBlock('Camera');

    // When
    page.answerBrowserBlock('restrict');

    // Then
    await expect(resolution).resolves.toBe('restricted');
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ label: LABEL, name: 'Camera', decision: 'denied' }));
  });

  it('As a dotli user, I restrict and the denial fails to save, and it rejects with the store error', async () => {
    // Given the blocked dialog on screen, and a store that fails to write
    const failure = new Error('write failed');
    record.mockRejectedValue(failure);
    const { resolution } = await showBlock('Camera');

    // When
    page.answerBrowserBlock('restrict');

    // Then
    await expect(resolution).rejects.toBe(failure);
  });

  it('As a dotli user, I close the blocked dialog and the grant is kept', async () => {
    // Given the blocked dialog on screen
    const { resolution } = await showBlock('Camera');

    // When
    page.dismiss();

    // Then
    await expect(resolution).resolves.toBe('kept');
  });

  it('As a dotli user, I fix my browser setting and retry, and the dialog closes as allowed', async () => {
    // Given the blocked dialog on screen
    const { resolution } = await showBlock('Camera');

    // When the user allows it in the browser's settings and presses Retry
    browserStatus = 'granted';
    page.answerBrowserBlock('retry');

    // Then
    await expect(resolution).resolves.toBe('allowed');
  });

  it('As a dotli user, I retry while my browser still blocks it and the dialog shows again saying so', async () => {
    // Given the blocked dialog on screen, and the browser still blocks it
    const { resolution } = await showBlock('Camera');

    // When the user retries, then restricts the dialog shown again
    page.answerBrowserBlock('retry');
    const shownAgain = await page.waitForPrompt({ matches: isRetriedBlock });
    page.answerBrowserBlock('restrict');

    // Then
    expect(shownAgain).toEqual({ kind: 'browserBlock', label: LABEL, permission: 'Camera', retried: true });
    await expect(resolution).resolves.toBe('restricted');
  });

  it('As a dotli user, I retry a blocked Notifications and the browser is asked inside my click', async () => {
    // Given the blocked dialog on screen, and a browser that grants Notifications when asked
    browser.request.mockReturnValue(Promise.resolve('granted'));
    const { resolution } = await showBlock('Notifications');

    // When
    page.answerBrowserBlock('retry');

    // Then
    await expect(resolution).resolves.toBe('allowed');
    expect(browser.request).toHaveBeenCalledOnce();
    expect(browser.read).not.toHaveBeenCalled();
  });

  it('As a dotli user, I retry and the browser cannot tell, and the dialog closes as allowed', async () => {
    // Given the blocked dialog on screen, and a browser that cannot say
    browserStatus = 'unknown';
    const { resolution } = await showBlock('Camera');

    // When
    page.answerBrowserBlock('retry');

    // Then
    await expect(resolution).resolves.toBe('allowed');
  });

  it('As a dotli integrator, I abort while the dialog is up and it rejects with an AbortError', async () => {
    // Given the blocked dialog on screen
    const { resolution } = await showBlock('Camera');

    // When
    controller.abort();

    // Then
    await expect(resolution).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('As a dotli integrator, I abort while the browser answers a Retry and it rejects with an AbortError', async () => {
    // Given the blocked dialog on screen, and a browser that has not answered its Notifications prompt yet
    let answerBrowser: (status: BrowserPermissionStatus) => void = () => undefined;
    browser.request.mockReturnValue(
      new Promise<BrowserPermissionStatus>(resolve => {
        answerBrowser = resolve;
      }),
    );
    const { resolution } = await showBlock('Notifications');

    // When the user retries, the integrator aborts, then the browser grants it
    page.answerBrowserBlock('retry');
    controller.abort();
    answerBrowser('granted');

    // Then
    await expect(resolution).rejects.toMatchObject({ name: 'AbortError' });
  });
});

/** Starts resolving `permission`'s block, and resolves once its dialog is on screen. */
async function showBlock(
  permission: EnforceablePermissionName,
): Promise<{ resolution: Promise<BrowserBlockResolution> }> {
  const resolution = resolveBrowserBlock({
    label: LABEL,
    permission,
    signal: controller.signal,
    prompts: page.prompts,
    browser,
    record,
  });
  await page.waitForPrompt();
  return { resolution };
}

function isRetriedBlock(prompt: FakePrompt): boolean {
  return prompt.kind === 'browserBlock' && prompt.retried;
}
