// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { recordReports } from '@dotli/metrics/testing';
import { resetAllStoresForTests } from '@dotli/shared/testing';
import type { FetchGrant, FetchGrantKey, FetchGrantStore } from '@dotli/storage';
import { createBlockingModalCoordinator } from '../../../kit/createBlockingModalCoordinator.js';
import { createHostFetchGate } from './createHostFetchGate.js';
import type { GrantAnswer } from './hostPrompts.js';
import { createFakePrompts } from './hostPrompts.fake.js';

const HOST = 'api.example.com';

afterEach(() => {
  resetAllStoresForTests();
});

describe('host fetch gate', () => {
  it('As a product worker, I fetch a host the user allowed always and am allowed with no prompt', async () => {
    // Given
    const page = createGatePage({ stored: 'allowed' });

    // When
    const allowed = await page.gate.isHostAllowed(HOST);

    // Then
    expect({ allowed, pending: page.prompts.listPending() }).toEqual({ allowed: true, pending: [] });
  });

  it.each<{ story: string; answer: GrantAnswer; expected: { allowed: boolean; stored: FetchGrant | null } }>([
    { story: 'Always allow', answer: 'granted', expected: { allowed: true, stored: 'allowed' } },
    { story: 'Deny', answer: 'denied', expected: { allowed: false, stored: 'denied' } },
    { story: 'Allow once', answer: 'granted-once', expected: { allowed: true, stored: null } },
    { story: 'a dismissal', answer: 'dismissed', expected: { allowed: false, stored: null } },
  ])(
    'As a user, I answer a fetch prompt with $story and the fetch and the stored decision follow it',
    async ({ answer, expected }) => {
      // Given
      const page = createGatePage();
      const allowing = page.gate.isHostAllowed(HOST);
      await page.prompts.waitForPrompt();

      // When
      page.prompts.decideHostAccess(answer);

      // Then
      expect({ allowed: await allowing, stored: page.grants.get(HOST) }).toEqual(expected);
    },
  );

  it('As a user, I see the product and the host in the fetch prompt', async () => {
    // Given
    const page = createGatePage();

    // When
    void page.gate.isHostAllowed(HOST);

    // Then
    await expect(page.prompts.waitForPrompt()).resolves.toEqual({ kind: 'hostAccess', label: 'myapp', host: HOST });
  });

  it('As a user, I allow a host once and the worker fetches it again with no prompt', async () => {
    // Given
    const page = createGatePage();
    const first = page.gate.isHostAllowed(HOST);
    await page.prompts.waitForPrompt();
    page.prompts.decideHostAccess('granted-once');
    await first;

    // When
    const allowed = await page.gate.isHostAllowed(HOST);

    // Then
    expect({ allowed, pending: page.prompts.listPending() }).toEqual({ allowed: true, pending: [] });
  });

  it('As a user, I dismiss a fetch prompt and the next fetch of that host asks again', async () => {
    // Given
    const page = createGatePage();
    const first = page.gate.isHostAllowed(HOST);
    await page.prompts.waitForPrompt();
    page.prompts.dismiss();
    await first;

    // When
    void page.gate.isHostAllowed(HOST);

    // Then
    await expect(page.prompts.waitForPrompt()).resolves.toMatchObject({ kind: 'hostAccess', host: HOST });
  });

  it('As a user, I see one prompt for fetches of one host made together, and my answer settles them all', async () => {
    // Given
    const page = createGatePage();
    const fetches = [page.gate.isHostAllowed(HOST), page.gate.isHostAllowed(HOST)];
    await page.prompts.waitForPrompt();
    const pending = page.prompts.listPending().length;

    // When
    page.prompts.dismiss();

    // Then
    expect({ pending, allowed: await Promise.all(fetches), after: page.prompts.listPending() }).toEqual({
      pending: 1,
      allowed: [false, false],
      after: [],
    });
  });

  it('As a product worker, I fetch while the grants cannot be read and am denied with no prompt', async () => {
    // Given
    const reports = recordReports({ onFinished: onTestFinished });
    const page = createGatePage({ failRead: true });

    // When
    const allowed = await page.gate.isHostAllowed(HOST);

    // Then
    expect({ allowed, pending: page.prompts.listPending() }).toEqual({ allowed: false, pending: [] });
    expect(reports.exceptions).toMatchObject([{ step: 'fetch_grant_read' }]);
  });

  it('As a user, I allow a host always while the grant cannot be saved and the fetch is denied', async () => {
    // Given
    const reports = recordReports({ onFinished: onTestFinished });
    const page = createGatePage({ failSave: true });
    const allowing = page.gate.isHostAllowed(HOST);
    await page.prompts.waitForPrompt();

    // When
    page.prompts.decideHostAccess('granted');

    // Then
    expect(await allowing).toBe(false);
    expect(reports.exceptions).toMatchObject([{ step: 'fetch_grant_write' }]);
  });

  it('As a product worker, I end my run while the user is asked and the fetch is denied', async () => {
    // Given
    const page = createGatePage();
    const allowing = page.gate.isHostAllowed(HOST);
    await page.prompts.waitForPrompt();

    // When
    page.scope.dispose();

    // Then
    expect(await allowing).toBe(false);
  });
});

type GatePageOptions = {
  stored?: FetchGrant;
  failRead?: boolean;
  failSave?: boolean;
};

/** A gate for 'myapp' over fake prompts, a fresh prompt scope and grants kept in a map by host. */
function createGatePage({ stored, failRead = false, failSave = false }: GatePageOptions = {}) {
  const grants = new Map<string, FetchGrant>();
  if (stored !== undefined) {
    grants.set(HOST, stored);
  }
  const store: Pick<FetchGrantStore, 'read' | 'save'> = {
    read: ({ host }: FetchGrantKey) =>
      failRead ? Promise.reject(new Error('grants unreadable')) : Promise.resolve(grants.get(host) ?? null),
    save: ({ host }: FetchGrantKey, grant: FetchGrant) => {
      if (failSave) {
        return Promise.reject(new Error('grants unwritable'));
      }
      grants.set(host, grant);
      return Promise.resolve();
    },
  };
  const prompts = createFakePrompts();
  const scope = createBlockingModalCoordinator().createScope();
  const gate = createHostFetchGate({ label: 'myapp', scope, prompts: prompts.prompts, grants: store });
  return {
    gate,
    prompts,
    scope,
    grants: { get: (host: string) => grants.get(host) ?? null },
  };
}
