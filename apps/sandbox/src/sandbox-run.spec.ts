// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SANDBOX_CONTRACT_PARAMS, SANDBOX_SCHEMA_VERSION } from '@dotli/sandbox-wire';
import { bindCaptureSink, type CaptureContext } from '@dotli/metrics';
import { bindLogSink, type LogLevel } from '@dotli/shared';

import type { LoadInput, LoadOutcome } from './load-product.js';
import { runSandbox, type SandboxRunDeps, type SandboxStep } from './sandbox-run.js';

const CID = 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy';

function sandboxUrl(overrides: Record<string, string> = {}, host = 'myapp.app.localhost'): string {
  const search = new URLSearchParams({
    [SANDBOX_CONTRACT_PARAMS.v]: String(SANDBOX_SCHEMA_VERSION),
    [SANDBOX_CONTRACT_PARAMS.cid]: CID,
    [SANDBOX_CONTRACT_PARAMS.chainBackend]: 'rpc-gateway',
    [SANDBOX_CONTRACT_PARAMS.network]: 'paseo-next-v2',
    ...overrides,
  });
  return `https://${host}/?${search.toString()}`;
}

interface Failure {
  step: SandboxStep;
  title: string;
  message: string;
  retry: (() => Promise<void>) | undefined;
}

interface Harness {
  deps: SandboxRunDeps;
  loads: LoadInput[];
  failures: Failure[];
  /** What the run did, in order. */
  events: string[];
  /** Presses the retry of the latest failure. Resolves once the load it asked for has settled. */
  retry: () => Promise<void>;
}

/** A sandbox whose every load ends with the next of `outcomes`, then with the last one. */
function harness(outcomes: LoadOutcome[]): Harness {
  const loads: LoadInput[] = [];
  const failures: Failure[] = [];
  const events: string[] = [];
  const deps: SandboxRunDeps = {
    configure: params => {
      events.push(`configure ${params.network}`);
    },
    load: input => {
      loads.push(input);
      events.push(`load ${String(input.attempt)}`);
      const outcome = outcomes[loads.length - 1] ?? outcomes.at(-1) ?? { outcome: 'loaded' };
      return Promise.resolve(outcome);
    },
    failed: step => {
      events.push(`failed ${step}`);
      failures.push({ step, title: '', message: '', retry: undefined });
    },
    show: (title, message, retry) => {
      const shown = failures.at(-1);
      if (shown !== undefined) {
        Object.assign(shown, { title, message, retry });
      }
    },
    retrying: () => {
      events.push('retrying');
    },
    askRerender: () => {
      events.push('ask rerender');
    },
    gatewayHost: () => 'ipfs.example',
    baseDomain: 'dot.li',
    recoverTimeoutMs: 6_000,
  };
  return {
    deps,
    loads,
    failures,
    events,
    retry: () => {
      const retry = failures.at(-1)?.retry;
      if (retry === undefined) {
        throw new Error('the latest failure offers no retry');
      }
      return retry();
    },
  };
}

const framed = (href: string): { href: string; framed: boolean } => ({ href, framed: true });

let captured: { err: unknown; ctx: CaptureContext }[] = [];
let expected: { err: unknown; step: string }[] = [];
let logged: { level: LogLevel; message: string }[] = [];
let unbind: () => void = () => undefined;

beforeEach(() => {
  captured = [];
  expected = [];
  logged = [];
  bindLogSink({
    emit: (level, message) => {
      logged.push({ level, message });
    },
  });
  unbind = bindCaptureSink({
    exception: (err, ctx) => {
      captured.push({ err, ctx });
    },
    expected: (err, ctx) => {
      expected.push({ err, step: ctx.step });
    },
  });
});

afterEach(() => {
  unbind();
  bindLogSink({ emit: () => undefined });
  vi.useRealTimers();
});

describe('runSandbox contract', () => {
  it('As an operator, I see a host contract this sandbox cannot use reported, and nothing loads', async () => {
    // Given
    const sandbox = harness([{ outcome: 'loaded' }]);

    // When
    await runSandbox(framed(sandboxUrl({ [SANDBOX_CONTRACT_PARAMS.v]: '999' })), sandbox.deps);

    // Then
    expect(sandbox.failures).toMatchObject([{ step: 'contract_params', title: 'Invalid sandbox URL' }]);
    expect(captured).toMatchObject([
      { err: { name: 'SandboxContractError' }, ctx: { flow: 'content', step: 'contract_params' } },
    ]);
    expect(sandbox.loads).toEqual([]);
  });

  it('As a visitor who opened the sandbox URL itself, I am sent to the host and no defect is reported', async () => {
    // Given
    const sandbox = harness([{ outcome: 'loaded' }]);

    // When
    await runSandbox({ href: sandboxUrl(), framed: false }, sandbox.deps);

    // Then
    expect(sandbox.failures).toMatchObject([{ step: 'contract_top_level', title: 'Sandbox URL not supported' }]);
    expect(expected.map(entry => entry.step)).toEqual(['contract_top_level']);
    expect(captured).toEqual([]);
    expect(sandbox.loads).toEqual([]);
  });

  it('As an operator, I see a sandbox served outside an app subdomain fail as a contract error', async () => {
    // Given
    const sandbox = harness([{ outcome: 'loaded' }]);

    // When
    await runSandbox(framed(sandboxUrl({}, 'app.dot.li')), sandbox.deps);

    // Then
    expect(sandbox.failures).toMatchObject([{ step: 'contract_origin' }]);
    expect(captured).toMatchObject([{ ctx: { step: 'contract_origin' } }]);
  });

  it('As a visitor whose sandbox reloaded without its params, I wait for the host to render it again and see the load fail if it does not in time', async () => {
    // Given a reload that stripped the params
    vi.useFakeTimers();
    const sandbox = harness([{ outcome: 'loaded' }]);
    await runSandbox(framed('https://myapp.app.localhost/'), sandbox.deps);
    const failuresBeforeTheWait = sandbox.failures.length;

    // When the host does not answer
    await vi.advanceTimersByTimeAsync(6_000);

    // Then
    expect(sandbox.events).toEqual(['ask rerender', 'failed contract_rerender']);
    expect(failuresBeforeTheWait).toBe(0);
    expect(sandbox.failures).toMatchObject([{ step: 'contract_rerender', title: 'Invalid sandbox URL' }]);
    expect(captured).toMatchObject([{ ctx: { step: 'contract_rerender' } }]);
  });

  it("As the sandbox, I apply the contract's settings before the first load", async () => {
    // Given
    const sandbox = harness([{ outcome: 'loaded' }]);

    // When
    await runSandbox(framed(sandboxUrl()), sandbox.deps);

    // Then
    expect(sandbox.events).toEqual(['configure paseo-next-v2', 'load 1']);
    expect(sandbox.loads[0]?.params).toMatchObject({ cid: CID, backend: 'rpc-gateway', fullReset: false });
    expect(sandbox.failures).toEqual([]);
  });
});

describe('runSandbox load failures', () => {
  it('As an operator, I see a failed load reported with its step, its backend and its attempt', async () => {
    // Given
    const error = new Error('bitswap_v1_get failed (code=-32602): invalid');
    const sandbox = harness([{ outcome: 'failed', step: 'content_fetch', error }]);

    // When
    await runSandbox(framed(sandboxUrl({ [SANDBOX_CONTRACT_PARAMS.chainBackend]: 'smoldot-direct' })), sandbox.deps);

    // Then
    expect(captured).toEqual([
      {
        err: error,
        ctx: {
          flow: 'content',
          step: 'content_fetch',
          tags: { surface: 'sandbox_main', dependency: 'smoldot-bitswap', attempt: '1' },
        },
      },
    ]);
    expect(sandbox.failures).toMatchObject([
      { step: 'content_fetch', title: 'Failed to load content', message: `${error.message} (via smoldot-bitswap)` },
    ]);
  });

  it('As a visitor on the gateway backend, I see an unreachable gateway named in plain words', async () => {
    // Given
    const sandbox = harness([{ outcome: 'failed', step: 'content_fetch', error: new TypeError('Failed to fetch') }]);

    // When
    await runSandbox(framed(sandboxUrl()), sandbox.deps);

    // Then
    expect(sandbox.failures).toMatchObject([
      { message: "Your browser couldn't connect to the trusted provider ipfs.example." },
    ]);
  });

  it('As a visitor leaving mid-load, I tear the frame down and the load shows and reports nothing', async () => {
    // Given
    const sandbox = harness([{ outcome: 'torn_down' }]);

    // When
    await runSandbox(framed(sandboxUrl()), sandbox.deps);

    // Then
    expect(sandbox.failures).toEqual([]);
    expect(captured).toEqual([]);
  });
});

describe('runSandbox retries', () => {
  const failed: LoadOutcome = { outcome: 'failed', step: 'content_fetch', error: new Error('unreachable') };

  it('As a visitor, I press retry and the product loads again as the next attempt', async () => {
    // Given
    const sandbox = harness([failed, { outcome: 'loaded' }]);
    await runSandbox(framed(sandboxUrl()), sandbox.deps);

    // When
    await sandbox.retry();

    // Then
    expect(sandbox.loads.map(load => load.attempt)).toEqual([1, 2]);
    expect(sandbox.events).toEqual(['configure paseo-next-v2', 'load 1', 'failed content_fetch', 'retrying', 'load 2']);
  });

  it('As a visitor, I press retry twice and the product loads once more, not twice', async () => {
    // Given a second load that is still running when retry is pressed again
    const sandbox = harness([failed]);
    let finishSecond: (outcome: LoadOutcome) => void = () => undefined;
    let secondStarted = (): void => undefined;
    const secondLoading = new Promise<void>(resolve => {
      secondStarted = resolve;
    });
    const load = sandbox.deps.load;
    sandbox.deps.load = input =>
      input.attempt === 2
        ? new Promise(resolve => {
            sandbox.loads.push(input);
            finishSecond = resolve;
            secondStarted();
          })
        : load(input);
    await runSandbox(framed(sandboxUrl()), sandbox.deps);
    const retry = sandbox.failures[0]?.retry ?? (() => Promise.reject(new Error('no retry offered')));

    // When
    const first = retry();
    const second = retry();
    await secondLoading;
    expect(sandbox.loads).toHaveLength(2);
    finishSecond({ outcome: 'loaded' });
    await Promise.all([first, second]);

    // Then the stale press neither loads nor shows a retry
    expect(sandbox.loads.map(entry => entry.attempt)).toEqual([1, 2]);
    expect(sandbox.events.filter(event => event === 'retrying')).toHaveLength(1);
  });

  it('As a visitor after five failed loads, I press retry and am asked to reload instead', async () => {
    // Given five failed loads
    const sandbox = harness([failed]);
    await runSandbox(framed(sandboxUrl()), sandbox.deps);
    for (let attempt = 2; attempt <= 5; attempt += 1) {
      await sandbox.retry();
    }

    // When
    await sandbox.retry();

    // Then
    expect(sandbox.loads).toHaveLength(5);
    expect(sandbox.failures.at(-1)).toEqual({
      step: 'retry_limit',
      title: 'Too many retry attempts',
      message: 'Reached 5 failed attempts. Reload the page to start over.',
      retry: undefined,
    });
    expect(logged).toContainEqual({ level: 'warn', message: '[dot.li app] Retry refused after 5 failed attempts' });
  });
});

describe('runSandbox broken dependencies', () => {
  it('As a visitor whose load rejects, I see an init failure with a retry, and the operator sees it reported', async () => {
    // Given a load that rejects instead of returning its outcome
    const sandbox = harness([{ outcome: 'loaded' }]);
    const broken = new Error('load blew up');
    sandbox.deps.load = () => Promise.reject(broken);

    // When
    await runSandbox(framed(sandboxUrl()), sandbox.deps);

    // Then
    expect(sandbox.events).toEqual(['configure paseo-next-v2', 'failed init']);
    expect(sandbox.failures).toMatchObject([{ step: 'init', title: 'Failed to load content' }]);
    expect(sandbox.failures[0]?.retry).toBeTypeOf('function');
    expect(captured).toMatchObject([{ err: broken, ctx: { step: 'init' } }]);
    expect(logged.map(line => [line.level, line.message])).toContainEqual([
      'error',
      '[dot.li app] The load rejected instead of returning its outcome load blew up',
    ]);
  });

  it('As a visitor whose failure cannot be shown, I still end the host loading screen, and the operator sees the throw', async () => {
    // Given a failed load whose error page throws
    const sandbox = harness([{ outcome: 'failed', step: 'content_fetch', error: new Error('unreachable') }]);
    const broken = new Error('error page blew up');
    sandbox.deps.show = () => {
      throw broken;
    };

    // When
    await runSandbox(framed(sandboxUrl()), sandbox.deps);

    // Then
    expect(sandbox.events).toEqual(['configure paseo-next-v2', 'load 1', 'failed content_fetch']);
    expect(captured).toMatchObject([
      { ctx: { step: 'content_fetch' } },
      { err: broken, ctx: { step: 'failure_show', tags: { failed_step: 'content_fetch' } } },
    ]);
    expect(logged.map(line => [line.level, line.message])).toContainEqual([
      'error',
      '[dot.li app] Could not show the content_fetch failure error page blew up',
    ]);
  });
});
