// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, onTestFinished, vi, type Mock } from 'vitest';
import { asProductId } from '@parity/truapi';
import { recordReports } from '@dotli/metrics/testing';
import { atom, type WritableAtom } from 'nanostores';
import { createBlockingModalCoordinator, type BlockingModalScope } from './createBlockingModalCoordinator.js';
import { createBrowserBlockCheck } from './createBrowserBlockCheck.js';
import type { BrowserPermissions, BrowserPermissionStatus } from './createBrowserPermissions.js';
import { toProductId } from './getAskedProductId.js';
import { createFakePrompts, type FakePrompt, type FakePrompts } from './hostPrompts.fake.js';
import type { EnforceablePermissionName, PermissionStatus, PermissionTargets } from './permissionPolicy.js';
import type { ProductPermissions } from './state/productPermissions.js';
import type { ProductState } from './state/productState.js';

type FakeBrowser = {
  checked: BrowserPermissions['checked'];
  read: Mock<BrowserPermissions['read']>;
  request: Mock<BrowserPermissions['request']>;
};

/** `getStatuses` over fixed grants, which records the label of each call and fails the calls it is told to. */
type FakeStatuses = ReturnType<typeof createFakeStatuses>;

const CHECKED: BrowserPermissions['checked'] = ['Notifications', 'Camera', 'Microphone', 'Location'];

let products: WritableAtom<ProductState>;
let page: FakePrompts;
let browserStatus: BrowserPermissionStatus;
let browser: FakeBrowser;
let scope: BlockingModalScope;
let record: Mock<ProductPermissions['recordPromptDecision']>;

beforeEach(() => {
  products = atom<ProductState>({ status: 'none', loadId: 0 });
  page = createFakePrompts();
  browserStatus = 'denied';
  browser = {
    checked: CHECKED,
    read: vi.fn<BrowserPermissions['read']>(() => Promise.resolve(browserStatus)),
    request: vi.fn<BrowserPermissions['request']>(() => null),
  };
  scope = createBlockingModalCoordinator().createScope();
  record = vi.fn<ProductPermissions['recordPromptDecision']>(() => Promise.resolve());
});

describe('createBrowserBlockCheck', () => {
  it('As a dotli user whose browser blocks a camera the app holds, I open the app and see the blocked dialog', async () => {
    // Given the app holds Camera in dot.li, and the check runs
    startCheck(createFakeStatuses({ app: { Camera: 'granted' } }));

    // When
    load('app');

    // Then
    await expect(page.waitForPrompt()).resolves.toEqual(blockOf('app', 'Camera'));
  });

  it('As a dotli user, I restrict at launch and the denial is recorded for that app', async () => {
    // Given the blocked dialog on screen for the app's Camera
    const statuses = createFakeStatuses({ app: { Camera: 'granted' } });
    startCheck(statuses);
    load('app');
    await page.waitForPrompt();

    // When the user restricts, and the check of the next app shows the first one done
    page.answerBrowserBlock('restrict');
    load('other');
    await statuses.calledFor('other');

    // Then
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ label: 'app', name: 'Camera', decision: 'denied' }));
  });

  it('As a dotli user, I open an app twice in one page load and the blocked dialog shows once', async () => {
    // Given the app's blocked dialog closed
    const statuses = createFakeStatuses({ app: { Camera: 'granted' }, other: { Camera: 'granted' } });
    startCheck(statuses);
    load('app');
    await page.waitForPrompt();
    page.dismiss();

    // When the app loads again, then another app
    load('app');
    load('other');
    const shown = await page.waitForPrompt();

    // Then
    expect(shown).toEqual(blockOf('other', 'Camera'));
    expect(statuses.labels).toEqual(['app', 'other']);
  });

  it('As a dotli user whose browser blocks two permissions, I see one dialog for each in turn', async () => {
    // Given the app holds Camera and Microphone, both blocked by the browser
    startCheck(createFakeStatuses({ app: { Camera: 'granted', Microphone: 'granted' } }));

    // When the user closes the first dialog
    load('app');
    const first = await page.waitForPrompt();
    page.dismiss();
    const second = await page.waitForPrompt({ matches: prompt => isBlockOf(prompt, 'app', 'Microphone') });

    // Then
    expect([first, second]).toEqual([blockOf('app', 'Camera'), blockOf('app', 'Microphone')]);
  });

  it('As a dotli user whose browser only asks, I open the app and see nothing', async () => {
    // Given the app holds Camera, which the browser would ask about
    browserStatus = 'prompt';
    const statuses = createFakeStatuses({ app: { Camera: 'granted' } });
    startCheck(statuses);

    // When the app loads, and the check of the next app shows the first one done
    load('app');
    load('other');
    await statuses.calledFor('other');

    // Then
    expect(page.listPending()).toEqual([]);
  });

  it('As a dotli user, I open an app granted nothing and the browser is not read', async () => {
    // Given an app granted nothing, and another granted only Camera
    startCheck(createFakeStatuses({ other: { Camera: 'granted' } }));

    // When both load
    load('app');
    load('other');
    await page.waitForPrompt({ matches: prompt => isBlockOf(prompt, 'other', 'Camera') });

    // Then
    expect(browser.read.mock.calls).toEqual([['Camera']]);
  });

  it('As a dotli user whose app connection drops during the check, I open the app again and it is checked again, and the failure is counted', async () => {
    // Given the app's statuses fail to read
    const reports = recordReports({ onFinished: onTestFinished });
    const statuses = createFakeStatuses({});
    statuses.failNext(new Error('connection closed'));
    startCheck(statuses);
    load('app');
    load('other');
    await statuses.calledFor('other');

    // When the app is on show again, and the check of the next app shows it was checked first
    load('app');
    load('third');
    await statuses.calledFor('third');

    // Then
    expect(reports.expected).toMatchObject([{ step: 'browser_block_check' }]);
    expect(statuses.labels).toEqual(['app', 'other', 'app', 'third']);
  });

  it("As a dotli user whose denial of one permission fails to save, I still see the dialog of the app's next blocked permission", async () => {
    // Given two blocked permissions, and a store that fails to write
    record.mockRejectedValue(new Error('write failed'));
    startCheck(createFakeStatuses({ app: { Camera: 'granted', Microphone: 'granted' } }));
    load('app');
    await page.waitForPrompt();

    // When the user restricts the first
    page.answerBrowserBlock('restrict');
    const next = await page.waitForPrompt({ matches: prompt => isBlockOf(prompt, 'app', 'Microphone') });

    // Then
    expect(next).toEqual(blockOf('app', 'Microphone'));
  });

  it('As a dotli user restricting one of two blocked permissions, I see the next dialog only once the denial is saved', async () => {
    // Given two blocked permissions, and a store whose write is still pending
    let saved = (): void => undefined;
    record.mockImplementation(
      () =>
        new Promise<void>(resolve => {
          saved = resolve;
        }),
    );
    startCheck(createFakeStatuses({ app: { Camera: 'granted', Microphone: 'granted' } }));
    load('app');
    await page.waitForPrompt();

    // When the user restricts the first, and the write has started
    page.answerBrowserBlock('restrict');
    await vi.waitFor(() => expect(record).toHaveBeenCalledOnce());
    const shownWhilePending = page.listPending();
    saved();
    const next = await page.waitForPrompt({ matches: prompt => isBlockOf(prompt, 'app', 'Microphone') });

    // Then
    expect(shownWhilePending).toEqual([]);
    expect(next).toEqual(blockOf('app', 'Microphone'));
  });

  it('As a dotli integrator, I dispose the launch scope while its dialog is up and nothing is reported', async () => {
    // Given the blocked dialog on screen
    const reports = recordReports({ onFinished: onTestFinished });
    const statuses = createFakeStatuses({ app: { Camera: 'granted' } });
    startCheck(statuses);
    load('app');
    await page.waitForPrompt();

    // When the scope is disposed, and the check of the next app shows the first one done
    scope.dispose();
    load('other');
    await statuses.calledFor('other');

    // Then
    expect(reports).toEqual({ exceptions: [], expected: [] });
  });

  it('As a dotli integrator, I stop the check and later loads are not checked', () => {
    // Given
    const statuses = createFakeStatuses({ app: { Camera: 'granted' } });
    const stop = startCheck(statuses);

    // When
    stop();
    load('app');

    // Then
    expect(statuses.labels).toEqual([]);
  });
});

/** Starts the launch check over the spec's fakes, stopped when the test finishes. */
function startCheck(statuses: FakeStatuses): () => void {
  const check = createBrowserBlockCheck({
    products,
    statuses: statuses.get,
    browser,
    scope,
    prompts: page.prompts,
    record,
  });
  const stop = check.start();
  onTestFinished(stop);
  return stop;
}

/** Puts `label` on show, as a new load. */
function load(label: string): void {
  products.set({
    status: 'loaded',
    loadId: products.get().loadId + 1,
    label,
    productId: asProductId(toProductId(label)),
    facts: {},
  });
}

function blockOf(label: string, permission: EnforceablePermissionName): FakePrompt {
  return { kind: 'browserBlock', label, permission, retried: false };
}

function isBlockOf(prompt: FakePrompt, label: string, permission: EnforceablePermissionName): boolean {
  return prompt.kind === 'browserBlock' && prompt.label === label && prompt.permission === permission;
}

function createFakeStatuses(grants: Readonly<Record<string, PermissionTargets>>) {
  const labels: string[] = [];
  const failures: Error[] = [];
  const waiters = new Set<() => void>();

  function get(label: string, permissions: readonly EnforceablePermissionName[]): Promise<PermissionStatus[]> {
    labels.push(label);
    for (const wake of [...waiters]) {
      wake();
    }
    const failure = failures.shift();
    if (failure !== undefined) {
      return Promise.reject(failure);
    }
    return Promise.resolve(permissions.map(name => grants[label]?.[name] ?? 'ask'));
  }

  return {
    /** The label of each call, in order. */
    labels,
    /** Fails the next call with `error`. */
    failNext(error: Error): void {
      failures.push(error);
    },
    get,
    /** Resolves once `label` has been read, woken by each call rather than polling. */
    calledFor(label: string): Promise<void> {
      return new Promise(resolve => {
        function check(): void {
          if (labels.includes(label)) {
            waiters.delete(check);
            resolve();
          }
        }
        waiters.add(check);
        check();
      });
    },
  };
}
