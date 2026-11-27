// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A stack's start over a fake builder, whose descriptor is a JSON list of specs and whose SHA-256 of a spec is its text.

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { recordReports } from '@dotli/metrics/testing';
import { catchRejection, createManualTimers } from '@dotli/shared/testing';
import {
  createStackBuilder,
  type LightClientStack,
  type LightSpecs,
  type LightSpecStore,
  type StackBuilder,
} from './createStackBuilder.js';

type FakeSpec = { genesisHash: string; role: string; url: string; sha256: string };

type FakeBuilder = StackBuilder & {
  /** Each added spec's text by genesis hash. */
  added: Map<string, string>;
  freed: boolean;
};

/** A response body, or the status of a failed answer. The last one repeats. */
type Served = string | number;

type StartParams = {
  stack: string;
  /** Whether the copy the start opens was fetched, so it is not stored until kept. */
  fetched?: boolean;
  /** The newer copy's descriptor, or `null` when none arrives. */
  newer?: string | null;
  /** The specs kept from an earlier start, by text. */
  kept?: string[];
  routes?: Record<string, Served[]>;
};

const POINTER = 'polkadotapp://stack?key=0xabc&url=https%3A%2F%2Fstacks.test%2Fpreviewnet.json';
const RELAY_URL = 'https://specs.test/relay.json';
const PEOPLE_URL = 'https://specs.test/people.json';
// The fake refuses this descriptor, as the engine refuses one signed with another key.
const UNSIGNED = 'unsigned';

function describeStack(relaySpec: string): string {
  const specs: FakeSpec[] = [
    { genesisHash: '0x01', role: 'relay', url: RELAY_URL, sha256: relaySpec },
    { genesisHash: '0x02', role: 'people', url: PEOPLE_URL, sha256: 'people-v1' },
  ];
  return JSON.stringify(specs);
}

function createFakeBuilder(): FakeBuilder {
  let specs: FakeSpec[] = [];
  const builder: FakeBuilder = {
    added: new Map(),
    freed: false,
    setStack(_link, descriptor) {
      const text = new TextDecoder().decode(descriptor);
      if (text === UNSIGNED) {
        throw new Error('descriptor signature does not match the link key');
      }
      specs = JSON.parse(text) as FakeSpec[];
    },
    lightSpecs: () => specs.map(({ genesisHash, role, url, sha256 }) => ({ genesisHash, role, url, sha256 })),
    addLightSpec(genesisHash, specification) {
      const text = new TextDecoder().decode(specification);
      const spec = specs.find(s => s.genesisHash === genesisHash);
      if (spec?.sha256 !== text) {
        throw new Error(`light spec of ${spec?.role ?? genesisHash} refused: spec bytes do not match sha256`);
      }
      builder.added.set(genesisHash, text);
    },
    free() {
      builder.freed = true;
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

/** A spec store in memory, whose kept set the test reads by text. */
function createSpecStore(kept: string[]): LightSpecStore & { kept: () => string[] } {
  let specs: LightSpecs = new Map(kept.map(text => [text, new TextEncoder().encode(text)]));
  return {
    kept: () => [...specs.keys()].sort(),
    get: () => Promise.resolve(specs),
    set: next => {
      specs = next;
      return Promise.resolve();
    },
  };
}

function toStack(descriptor: string): LightClientStack {
  return { pointer: POINTER, descriptor: new TextEncoder().encode(descriptor) };
}

function start({ stack, fetched = false, newer = null, kept = [], routes = {} }: StartParams) {
  const timers = createManualTimers();
  const { fetch, requested } = createFakeFetch(routes);
  const lightSpecs = createSpecStore(kept);
  const builders: FakeBuilder[] = [];
  // Whether the starting and the newer copy were kept for the next start.
  let startKept = false;
  let newerKept = false;
  const builder = createStackBuilder({
    source: {
      stack: {
        ...toStack(stack),
        keep: fetched
          ? () => {
              startKept = true;
              return Promise.resolve();
            }
          : null,
      },
      newer: Promise.resolve(
        newer === null
          ? null
          : {
              ...toStack(newer),
              keep: () => {
                newerKept = true;
                return Promise.resolve();
              },
            },
      ),
      lightSpecs,
    },
    createBuilder: () => {
      const created = createFakeBuilder();
      builders.push(created);
      return created;
    },
    fetch,
    timers,
  });
  return {
    builder,
    builders,
    lightSpecs,
    requested,
    timers,
    isStartKept: () => startKept,
    isNewerKept: () => newerKept,
  };
}

/** Resolves once `met` holds. */
function until(met: () => boolean): Promise<void> {
  return vi.waitFor(() => {
    if (!met()) {
      throw new Error('not yet');
    }
  });
}

describe('createStackBuilder', () => {
  it('As the light client, I start from a stack whose specs I kept and fetch none of them', async () => {
    // Given
    const { builder, requested } = start({ stack: describeStack('relay-v1'), kept: ['people-v1', 'relay-v1'] });

    // When
    const { added } = await builder;

    // Then
    expect(Object.fromEntries(added)).toEqual({ '0x01': 'relay-v1', '0x02': 'people-v1' });
    expect(requested).toEqual([]);
  });

  it('As the light client, I start from a fetched copy and keep it once the engine accepted it and its specs are kept', async () => {
    // Given a copy fetched for a start with nothing stored
    const { builder, lightSpecs, isStartKept } = start({
      stack: describeStack('relay-v1'),
      fetched: true,
      routes: { [RELAY_URL]: ['relay-v1'], [PEOPLE_URL]: ['people-v1'] },
    });

    // When
    await builder;
    await until(isStartKept);

    // Then
    expect(lightSpecs.kept()).toEqual(['people-v1', 'relay-v1']);
  });

  it('As the light client, I never keep a fetched copy whose spec the engine refused', async () => {
    // Given a fetched copy whose relay spec was re-published since, with no newer copy
    const { builder, isStartKept } = start({
      stack: describeStack('relay-v1'),
      fetched: true,
      routes: { [RELAY_URL]: ['relay-v2'], [PEOPLE_URL]: ['people-v1'] },
    });

    // When
    await catchRejection(builder);

    // Then
    expect(isStartKept()).toBe(false);
  });

  it('As the light client, I start with specs I do not hold and keep the set the engine accepted for the next start', async () => {
    // Given a kept spec the stack no longer names
    const { builder, lightSpecs } = start({
      stack: describeStack('relay-v1'),
      kept: ['relay-v0'],
      routes: { [RELAY_URL]: ['relay-v1'], [PEOPLE_URL]: ['people-v1'] },
    });

    // When
    await builder;

    // Then
    expect(lightSpecs.kept()).toEqual(['people-v1', 'relay-v1']);
  });

  it('As the light client, I start from a copy whose spec went stale and keep the newer copy with its specs', async () => {
    // Given a relay spec re-published since the copy the start opens
    const { builder, lightSpecs, isNewerKept } = start({
      stack: describeStack('relay-v1'),
      newer: describeStack('relay-v2'),
      routes: { [RELAY_URL]: ['relay-v2'], [PEOPLE_URL]: ['people-v1'] },
    });

    // When
    const { added } = await builder;

    // Then
    expect(Object.fromEntries(added)).toEqual({ '0x01': 'relay-v2', '0x02': 'people-v1' });
    expect(lightSpecs.kept()).toEqual(['people-v1', 'relay-v2']);
    expect(isNewerKept()).toBe(true);
  });

  it('As the light client, I start while a spec fails twice and get it on a retry', async () => {
    // Given
    const { builder, timers } = start({
      stack: describeStack('relay-v1'),
      routes: { [RELAY_URL]: [503, 503, 'relay-v1'], [PEOPLE_URL]: ['people-v1'] },
    });

    // When
    await timers.advance(10_000);
    const { added } = await builder;

    // Then
    expect(added.get('0x01')).toBe('relay-v1');
  });

  it.each<{ when: string; params: StartParams; failure: string }>([
    {
      when: 'a spec still fails after its retries',
      params: { stack: describeStack('relay-v1'), routes: { [RELAY_URL]: [503], [PEOPLE_URL]: ['people-v1'] } },
      failure: `The light spec of relay (0x01) from ${RELAY_URL} could not be fetched`,
    },
    {
      when: 'the engine refuses the copy the start opens',
      params: { stack: UNSIGNED },
      failure: 'The light client refused the starting descriptor',
    },
    {
      when: 'a spec is refused and no newer copy arrives',
      params: { stack: describeStack('relay-v1'), routes: { [RELAY_URL]: ['relay-v2'], [PEOPLE_URL]: ['people-v1'] } },
      failure: 'newer than the refused one could be had',
    },
    {
      when: 'the engine refuses the newer copy',
      params: {
        stack: describeStack('relay-v1'),
        newer: UNSIGNED,
        routes: { [RELAY_URL]: ['relay-v2'], [PEOPLE_URL]: ['people-v1'] },
      },
      failure: 'The light client refused the newer descriptor',
    },
    {
      when: 'the engine refuses a spec of the newer copy',
      params: {
        stack: describeStack('relay-v1'),
        newer: describeStack('relay-v3'),
        routes: { [RELAY_URL]: ['relay-v2'], [PEOPLE_URL]: ['people-v1'] },
      },
      failure: `The light spec of relay (0x01) from ${RELAY_URL} was refused`,
    },
  ])('As the light client, I see the start fail with its cause when $when', async ({ params, failure }) => {
    // Given
    const { builder, timers } = start(params);

    // When
    const rejection = catchRejection(builder);
    await timers.advance(10_000);

    // Then
    expect(await rejection).toMatchObject({
      message: expect.stringContaining(failure) as string,
      cause: expect.any(Error) as Error,
    });
  });

  it('As the light client, I keep a newer copy and its specs for the next start on a builder I free, and keep running on mine', async () => {
    // Given a newer copy that re-published the relay spec
    const { builder, builders, lightSpecs, requested, isNewerKept } = start({
      stack: describeStack('relay-v1'),
      newer: describeStack('relay-v2'),
      kept: ['people-v1', 'relay-v1'],
      routes: { [RELAY_URL]: ['relay-v2'] },
    });

    // When
    const { added } = await builder;
    await until(isNewerKept);

    // Then
    expect(lightSpecs.kept()).toEqual(['people-v1', 'relay-v2']);
    expect(requested).toEqual([RELAY_URL]);
    expect(builders[1]?.freed).toBe(true);
    expect(added.get('0x01')).toBe('relay-v1');
  });

  it("As the light client, I start although a newer copy's spec cannot be had, keep neither that copy nor its specs, and see it reported", async () => {
    // Given
    const reports = recordReports({ onFinished: onTestFinished });
    const { builder, lightSpecs, timers, isNewerKept } = start({
      stack: describeStack('relay-v1'),
      newer: describeStack('relay-v2'),
      kept: ['people-v1', 'relay-v1'],
      routes: { [RELAY_URL]: [503] },
    });

    // When
    const { added } = await builder;
    await timers.advance(10_000);
    await until(() => reports.expected.length > 0);

    // Then
    expect(added.get('0x01')).toBe('relay-v1');
    expect(reports.expected).toMatchObject([{ step: 'light_spec_refresh' }]);
    expect(lightSpecs.kept()).toEqual(['people-v1', 'relay-v1']);
    expect(isNewerKept()).toBe(false);
  });
});
