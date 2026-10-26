// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createSiteGroups } from './site-groups.js';

const LIST_URL = 'https://dot.li/assets/public-suffix-list.dat';
const LIST = 'com\nio\ngithub.io\n';

/** A fetch that answers each load with the next of `answers`, recording each URL it was asked for. */
function fakeFetch(answers: (() => Promise<Response>)[]) {
  const asked: (RequestInfo | URL)[] = [];
  const fetch = (input: RequestInfo | URL): Promise<Response> => {
    asked.push(input);
    const answer = answers.shift();
    return answer === undefined ? Promise.reject(new Error('The fake fetch has no answer left')) : answer();
  };
  return { fetch, asked };
}

const listResponse = (): Promise<Response> => Promise.resolve(new Response(LIST));

describe('site groups', () => {
  it('As a session window, I ask for two registrable domains at once and the list loads once', async () => {
    // Given a list that loads
    const { fetch, asked } = fakeFetch([listResponse, listResponse]);
    const groups = createSiteGroups({ listUrl: LIST_URL, fetch });

    // When two hostnames are asked for together, and one more after
    const together = await Promise.all([groups.registrable('alice.github.io'), groups.registrable('shop.my-site.com')]);
    const after = await groups.registrable('github.io');

    // Then each has its registrable domain, and the list was fetched once
    expect(together).toEqual(['alice.github.io', 'my-site.com']);
    expect(after).toBeNull();
    expect(asked).toEqual([LIST_URL]);
  });

  it.each([
    ['a fetch that fails', () => Promise.reject(new Error('The network is down'))],
    ['an answer that is not ok', () => Promise.resolve(new Response('Not found', { status: 404 }))],
  ])(
    'As a session window whose list load meets %s, I am rejected and the next ask loads again',
    async (_name, failure) => {
      // Given a list whose first load fails
      const { fetch, asked } = fakeFetch([failure, listResponse]);
      const groups = createSiteGroups({ listUrl: LIST_URL, fetch });

      // When a hostname is asked for, then asked for again
      const first = await groups.registrable('my-site.com').catch((error: unknown) => error);
      const second = await groups.registrable('my-site.com');

      // Then the first ask was rejected, and the second loaded the list again and has the registrable domain
      expect(first).toBeInstanceOf(Error);
      expect(second).toBe('my-site.com');
      expect(asked).toEqual([LIST_URL, LIST_URL]);
    },
  );
});
