// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A stack's start over a fake builder, whose descriptor is a JSON list of specs and whose digest of a spec is its text.

import { describe, expect, it } from 'vitest';
import { catchRejection, createManualTimers } from '@dotli/shared/testing';
import { createStackBuilder, type StackBuilder } from './createStackBuilder.js';

type FakeSpec = { genesisHash: string; role: string; url: string; digest: string };

type FakeBuilder = StackBuilder & {
  /** Each added spec's text by genesis hash. */
  added: Map<string, string>;
};

/** A response body, or the status of a failed answer. The last one repeats. */
type Served = string | number;

const LIVE_URL = 'https://stacks.test/previewnet.json';
const POINTER = `polkadotapp://stack?key=0xabc&url=${encodeURIComponent(LIVE_URL)}`;
const RELAY_URL = 'https://specs.test/relay.json';
const PEOPLE_URL = 'https://specs.test/people.json';
// The fake refuses this descriptor, as the engine refuses one signed with another key.
const UNSIGNED = 'unsigned';

function describeStack(relayDigest: string): string {
  const specs: FakeSpec[] = [
    { genesisHash: '0x01', role: 'relay', url: RELAY_URL, digest: relayDigest },
    { genesisHash: '0x02', role: 'people', url: PEOPLE_URL, digest: 'people-v1' },
  ];
  return JSON.stringify(specs);
}

function createFakeBuilder(): FakeBuilder {
  let specs: FakeSpec[] = [];
  const builder: FakeBuilder = {
    added: new Map(),
    setStack(_link, descriptor) {
      const text = new TextDecoder().decode(descriptor);
      if (text === UNSIGNED) {
        throw new Error('descriptor signature does not match the link key');
      }
      specs = JSON.parse(text) as FakeSpec[];
    },
    lightSpecs: () => specs.map(({ genesisHash, role, url }) => ({ genesisHash, role, url })),
    addLightSpec(genesisHash, specification) {
      const text = new TextDecoder().decode(specification);
      const spec = specs.find(s => s.genesisHash === genesisHash);
      if (spec?.digest !== text) {
        throw new Error(`light spec of ${spec?.role ?? genesisHash} refused: spec bytes do not match sha256`);
      }
      builder.added.set(genesisHash, text);
    },
  };
  return builder;
}

function createFakeFetch(routes: Record<string, Served[]>): { fetch: typeof fetch; requested: string[] } {
  const requested: string[] = [];
  const served = new Map(Object.entries(routes).map(([url, answers]) => [url, [...answers]]));
  return {
    requested,
    fetch: input => {
      if (typeof input !== 'string') {
        throw new Error('the fake fetch takes a URL string');
      }
      requested.push(input);
      const answers = served.get(input) ?? [404];
      const answer = answers.length > 1 ? answers.shift() : answers[0];
      return Promise.resolve(
        typeof answer === 'string' ? new Response(answer) : new Response(null, { status: answer ?? 404 }),
      );
    },
  };
}

function start(bundled: string, routes: Record<string, Served[]>) {
  const timers = createManualTimers();
  const { fetch, requested } = createFakeFetch(routes);
  const builder = createStackBuilder({
    stack: { pointer: POINTER, descriptor: new TextEncoder().encode(bundled) },
    createBuilder: createFakeBuilder,
    fetch,
    timers,
  });
  return { builder, requested, timers };
}

describe('createStackBuilder', () => {
  it('As the light client, I start from a current build copy and get every spec of its descriptor without fetching the live one', async () => {
    // Given
    const { builder, requested } = start(describeStack('relay-v1'), {
      [RELAY_URL]: ['relay-v1'],
      [PEOPLE_URL]: ['people-v1'],
    });

    // When
    const { added } = await builder;

    // Then
    expect(Object.fromEntries(added)).toEqual({ '0x01': 'relay-v1', '0x02': 'people-v1' });
    expect(requested).not.toContain(LIVE_URL);
  });

  it("As the light client, I start from a build copy whose spec went stale and get the live descriptor's specs", async () => {
    // Given a relay spec re-published since the build copy
    const { builder } = start(describeStack('relay-v1'), {
      [RELAY_URL]: ['relay-v2'],
      [PEOPLE_URL]: ['people-v1'],
      [LIVE_URL]: [describeStack('relay-v2')],
    });

    // When
    const { added } = await builder;

    // Then
    expect(Object.fromEntries(added)).toEqual({ '0x01': 'relay-v2', '0x02': 'people-v1' });
  });

  it('As the light client, I start while a spec fails twice and get it on a retry', async () => {
    // Given
    const { builder, timers } = start(describeStack('relay-v1'), {
      [RELAY_URL]: [503, 503, 'relay-v1'],
      [PEOPLE_URL]: ['people-v1'],
    });

    // When
    await timers.advance(10_000);
    const { added } = await builder;

    // Then
    expect(added.get('0x01')).toBe('relay-v1');
  });

  it.each<{ when: string; bundled: string; routes: Record<string, Served[]>; failure: string }>([
    {
      when: 'a spec still fails after its retries',
      bundled: describeStack('relay-v1'),
      routes: { [RELAY_URL]: [503], [PEOPLE_URL]: ['people-v1'] },
      failure: `The light spec of relay (0x01) from ${RELAY_URL} could not be fetched`,
    },
    {
      when: 'the engine refuses the build copy',
      bundled: UNSIGNED,
      routes: {},
      failure: 'The light client refused the bundled descriptor',
    },
    {
      when: 'the live descriptor cannot be fetched',
      bundled: describeStack('relay-v1'),
      routes: { [RELAY_URL]: ['relay-v2'], [PEOPLE_URL]: ['people-v1'], [LIVE_URL]: [503] },
      failure: 'The live descriptor of stack',
    },
    {
      when: 'the engine refuses the live descriptor',
      bundled: describeStack('relay-v1'),
      routes: { [RELAY_URL]: ['relay-v2'], [PEOPLE_URL]: ['people-v1'], [LIVE_URL]: [UNSIGNED] },
      failure: 'The light client refused the live descriptor',
    },
    {
      when: 'the engine refuses a spec of the live descriptor',
      bundled: describeStack('relay-v1'),
      routes: { [RELAY_URL]: ['relay-v2'], [PEOPLE_URL]: ['people-v1'], [LIVE_URL]: [describeStack('relay-v3')] },
      failure: `The light spec of relay (0x01) from ${RELAY_URL} was refused`,
    },
  ])('As the light client, I see the start fail with its cause when $when', async ({ bundled, routes, failure }) => {
    // Given
    const { builder, timers } = start(bundled, routes);

    // When
    const rejection = catchRejection(builder);
    await timers.advance(10_000);

    // Then
    expect(await rejection).toMatchObject({
      message: expect.stringContaining(failure) as string,
      cause: expect.any(Error) as Error,
    });
  });
});
