// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest';

import { SANDBOX_CONTRACT_PARAMS, SANDBOX_SCHEMA_VERSION } from '@dotli/sandbox-wire';
import { bindCaptureSink, type CaptureContext } from '@dotli/metrics';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import { CONTENT_ERRORS } from '@dotli/content';
import { bindLogSink, createDeferred, setErrorName } from '@dotli/shared';

import type { HostMessages } from './createHostMessages.js';
import type { LoadInput, LoadOutcome } from './loadProduct.js';
import type { SandboxPage } from './readSandboxContract.js';
import type { SandboxStep } from './describeSandboxFailure.js';
import { DecryptionCancelledError } from './errors.js';
import { runSandbox, type RunSandboxDeps } from './runSandbox.js';

type Failure = {
  step: SandboxStep;
  title: string;
  message: string;
  retry: (() => void) | undefined;
};

type Run = ReturnType<typeof runSandbox>;

type Harness = {
  deps: RunSandboxDeps;
  loads: LoadInput[];
  failures: Failure[];
  /** What the run did, in order. */
  events: string[];
  /** Starts the run on `page`, and keeps it as `run`. */
  start: (page: SandboxPage) => Run;
  /** The run `start` began. Throws before `start`. */
  readonly run: Run;
  /** Presses the retry of the latest failure. Resolves once the run has settled. */
  retry: () => Promise<void>;
  /** The host accepts the recover ask, which settles the run's wait for it. */
  accept: () => void;
  /** The wait for the host's acceptance passes its deadline with `reason`. */
  giveUp: (reason: Error) => void;
};

const CID = 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy';

function createSandboxUrl({
  overrides = {},
  host = 'myapp.app.localhost',
}: { overrides?: Record<string, string>; host?: string } = {}): string {
  const search = new URLSearchParams({
    [SANDBOX_CONTRACT_PARAMS.v]: String(SANDBOX_SCHEMA_VERSION),
    [SANDBOX_CONTRACT_PARAMS.cid]: CID,
    [SANDBOX_CONTRACT_PARAMS.chainBackend]: 'rpc-gateway',
    [SANDBOX_CONTRACT_PARAMS.network]: 'paseo-next-v2',
    ...overrides,
  });
  return `https://${host}/?${search.toString()}`;
}

/**
 * A sandbox whose every load ends with the next of `outcomes`, then with the last one. `askRerender` replaces its ask to
 * the host when given.
 */
function createHarness(
  outcomes: LoadOutcome[],
  { askRerender }: { askRerender?: HostMessages['askRerender'] } = {},
): Harness {
  const loads: LoadInput[] = [];
  const failures: Failure[] = [];
  const events: string[] = [];
  const acceptance = createDeferred<undefined>();
  let started: Run | undefined;
  const deps: RunSandboxDeps = {
    configure: params => {
      events.push(`configure ${params.network}`);
    },
    load(input) {
      loads.push(input);
      events.push(`load ${String(input.attempt)}`);
      const outcome = outcomes[loads.length - 1] ?? outcomes.at(-1) ?? { outcome: 'loaded' };
      return Promise.resolve(outcome);
    },
    hostMessages: {
      notifyLoadingDone(result) {
        if (result.outcome === 'failed') {
          events.push(`failed ${result.failedStep}`);
          failures.push({ step: result.failedStep, title: '', message: '', retry: undefined });
        }
      },
      askRerender:
        askRerender ??
        (() => {
          events.push('ask rerender');
        }),
    },
    ui: {
      showError(title, message, { retry } = {}) {
        const shown = failures.at(-1);
        if (shown !== undefined) {
          Object.assign(shown, { title, message, retry });
        }
      },
      showRetryScreen: () => {
        events.push('retrying');
      },
    },
    waitForRecoverAccepted() {
      events.push('wait');
      return acceptance.promise;
    },
    getGatewayHost: () => 'ipfs.example',
    baseDomain: 'dot.li',
  };
  return {
    deps,
    loads,
    failures,
    events,
    start: page => {
      started = runSandbox(page, deps);
      return started;
    },
    get run() {
      if (started === undefined) {
        throw new Error('the run has not started');
      }
      return started;
    },
    retry: retryLatest,
    accept: () => {
      acceptance.resolve(undefined);
    },
    giveUp: reason => {
      acceptance.reject(reason);
    },
  };

  function retryLatest(): Promise<void> {
    const retry = failures.at(-1)?.retry;
    if (retry === undefined || started === undefined) {
      throw new Error('the latest failure offers no retry');
    }
    retry();
    return started.await();
  }
}

function toFramedPage(href: string): { href: string; framed: boolean } {
  return { href, framed: true };
}

let captured: { error: unknown; context: CaptureContext }[] = [];
let expected: { error: unknown; step: string }[] = [];
let unbind: () => void = () => undefined;
let unbindLog: () => void = () => undefined;

beforeEach(() => {
  captured = [];
  expected = [];
  unbindLog = bindLogSink({ emit: () => undefined });
  unbind = bindCaptureSink({
    exception: (error, context) => {
      captured.push({ error, context });
    },
    expected: (error, context) => {
      expected.push({ error, step: context.step });
    },
  });
});

afterEach(() => {
  unbind();
  unbindLog();
});

describe('runSandbox contract', () => {
  it('As an operator, I serve a host contract this sandbox cannot use and see it reported while nothing loads', async () => {
    // Given
    const sandbox = createHarness([{ outcome: 'loaded' }]);

    // When
    await sandbox.start(toFramedPage(createSandboxUrl({ overrides: { [SANDBOX_CONTRACT_PARAMS.v]: '999' } }))).await();

    // Then
    expect(sandbox.failures).toMatchObject([{ step: 'contract_params', title: 'Invalid sandbox URL' }]);
    expect(captured).toMatchObject([
      {
        error: { name: 'SandboxContractError', cause: { name: 'SandboxContractError', recoverable: false } },
        context: { step: 'contract_params' },
      },
    ]);
    expect(sandbox.loads).toEqual([]);
  });

  it('As a visitor who opened the sandbox URL itself, I am sent to the host and no defect is reported', async () => {
    // Given
    const sandbox = createHarness([{ outcome: 'loaded' }]);
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });

    // When
    await sandbox.start({ href: createSandboxUrl(), framed: false }).await();

    // Then
    expect(sandbox.failures).toMatchObject([{ step: 'contract_top_level', title: 'Sandbox URL not supported' }]);
    expect(expected.map(entry => entry.step)).toEqual(['contract_top_level']);
    expect(sentry.counted('app.run')).toEqual([{ outcome: 'error', reason: 'top_level' }]);
    expect(captured).toEqual([]);
    expect(sandbox.loads).toEqual([]);
  });

  it('As an operator, I serve a sandbox outside an app subdomain and see it fail as a contract error', async () => {
    // Given
    const sandbox = createHarness([{ outcome: 'loaded' }]);

    // When
    await sandbox.start(toFramedPage(createSandboxUrl({ host: 'app.dot.li' }))).await();

    // Then
    expect(sandbox.failures).toMatchObject([{ step: 'contract_origin' }]);
    expect(captured).toMatchObject([{ context: { step: 'contract_origin' } }]);
  });

  it('As a developer on local.host, I open my sandbox on its app subdomain and it loads the product', async () => {
    // Given a sandbox whose product loads
    const sandbox = createHarness([{ outcome: 'loaded' }]);

    // When it runs on an app subdomain of local.host
    await sandbox.start(toFramedPage(createSandboxUrl({ host: 'myapp.app.local.host:4322' }))).await();

    // Then the product is configured and loaded with no failure
    expect(sandbox.events).toEqual(['configure paseo-next-v2', 'load 1']);
    expect(sandbox.failures).toEqual([]);
  });

  it('As an operator, I serve a sandbox on local.host outside an app subdomain and see it fail as a contract error', async () => {
    // Given a sandbox whose product loads
    const sandbox = createHarness([{ outcome: 'loaded' }]);

    // When it runs on local.host outside an app subdomain
    await sandbox.start(toFramedPage(createSandboxUrl({ host: 'myapp.local.host:4322' }))).await();

    // Then it fails the origin contract
    expect(sandbox.failures).toMatchObject([{ step: 'contract_origin' }]);
  });

  it('As a visitor whose sandbox reloaded without its params, I wait for the host to render it again and see the load fail if it never accepts my ask', async () => {
    // Given a reload that stripped the params
    const sandbox = createHarness([{ outcome: 'loaded' }]);
    sandbox.start(toFramedPage('https://myapp.app.localhost/'));
    const failuresBeforeTheWait = sandbox.failures.length;
    const deadline = new Error('The host did not accept the recover ask in time');

    // When the host does not answer before the wait's deadline
    sandbox.giveUp(deadline);
    await sandbox.run.await();

    // Then
    expect(sandbox.events).toEqual(['ask rerender', 'wait', 'failed contract_rerender']);
    expect(failuresBeforeTheWait).toBe(0);
    expect(sandbox.failures).toMatchObject([{ step: 'contract_rerender', title: 'Invalid sandbox URL' }]);
    expect(captured).toMatchObject([
      { error: { name: 'SandboxContractError', cause: deadline }, context: { step: 'contract_rerender' } },
    ]);
  });

  it('As a visitor whose sandbox reloaded without its params, I wait for the host to render it again and see no failure once it accepted', async () => {
    // Given a reload that stripped the params
    const sandbox = createHarness([{ outcome: 'loaded' }]);
    sandbox.start(toFramedPage('https://myapp.app.localhost/'));

    // When the host accepts the recover ask
    sandbox.accept();
    await sandbox.run.await();

    // Then the wait ended with the acceptance and nothing failed
    expect(sandbox.events).toEqual(['ask rerender', 'wait']);
    expect(sandbox.failures).toEqual([]);
    expect(captured).toEqual([]);
  });

  it('As a visitor whose sandbox reloaded without its params and cannot reach its host, I see the load fail at once and no wait is started', async () => {
    // Given a sandbox whose ask to the host throws
    const unreachable = new Error('The host window is gone');
    const sandbox = createHarness([{ outcome: 'loaded' }], {
      askRerender: () => {
        throw unreachable;
      },
    });

    // When the run starts on a URL the reload stripped
    await sandbox.start(toFramedPage('https://myapp.app.localhost/')).await();

    // Then the ask's failure is shown and reported, and no wait is started
    expect(sandbox.failures).toMatchObject([{ step: 'contract_rerender', title: 'Invalid sandbox URL' }]);
    expect(sandbox.events).not.toContain('wait');
    expect(captured).toMatchObject([
      { error: { name: 'SandboxContractError', cause: unreachable }, context: { step: 'contract_rerender' } },
    ]);
    expect(captured).toHaveLength(1);
  });

  it('As a visitor whose sandbox reloaded without its params, I see the load fail at once when the wait for the host cannot start', async () => {
    // Given a sandbox whose wait for the host's acceptance throws as it starts
    const sandbox = createHarness([{ outcome: 'loaded' }]);
    const broken = new Error('The wait could not start');
    sandbox.deps.waitForRecoverAccepted = () => {
      throw broken;
    };

    // When the run starts on a URL the reload stripped, and no time passes
    await sandbox.start(toFramedPage('https://myapp.app.localhost/')).await();

    // Then the ask went out, and the failure is shown and reported without waiting out the deadline
    expect(sandbox.events).toEqual(['ask rerender', 'failed contract_rerender']);
    expect(sandbox.failures).toMatchObject([{ step: 'contract_rerender', title: 'Invalid sandbox URL' }]);
    expect(captured).toMatchObject([{ context: { step: 'contract_rerender' } }]);
    expect(captured[0]?.error).toMatchObject({ cause: broken });
  });
});

describe('runSandbox load failures', () => {
  it('As an operator, I watch a load fail and see it reported with its step, its backend and its attempt', async () => {
    // Given
    const error = new Error('bitswap_v1_get failed (code=-32602): invalid');
    const sandbox = createHarness([{ outcome: 'failed', step: 'content_fetch', error }]);

    // When
    await sandbox
      .start(
        toFramedPage(createSandboxUrl({ overrides: { [SANDBOX_CONTRACT_PARAMS.chainBackend]: 'smoldot-direct' } })),
      )
      .await();

    // Then
    expect(captured).toMatchObject([
      {
        error,
        context: {
          step: 'content_fetch',
          tags: { surface: 'sandbox_main', dependency: 'smoldot-bitswap', attempt: '1' },
        },
      },
    ]);
    expect(sandbox.failures).toMatchObject([
      { step: 'content_fetch', title: 'Failed to load content', message: `${error.message} (via smoldot-bitswap)` },
    ]);
  });

  it('As a visitor on the gateway backend, I hit an unreachable gateway and see it named in plain words', async () => {
    // Given
    const sandbox = createHarness([
      {
        outcome: 'failed',
        step: 'content_fetch',
        error: setErrorName(
          new Error('IPFS gateway ipfs.example unreachable for bafy'),
          CONTENT_ERRORS.GATEWAY_UNREACHABLE,
        ),
      },
    ]);

    // When
    await sandbox.start(toFramedPage(createSandboxUrl())).await();

    // Then
    expect(sandbox.failures).toMatchObject([
      { message: "Your browser couldn't connect to the trusted provider ipfs.example." },
    ]);
  });

  it.each([
    ['a bare fetch TypeError', new TypeError('Failed to fetch'), 'Failed to fetch (via ipfs-gateway)'],
    [
      'a failed dynamic import',
      new TypeError('Failed to fetch dynamically imported module: https://x.example/a.js'),
      'Failed to fetch dynamically imported module: https://x.example/a.js (via ipfs-gateway)',
    ],
  ])(
    'As a visitor on the gateway backend, I hit %s and see its own words, not the gateway advice',
    async (_label, error, message) => {
      // Given a content load that fails with an error that is not the gateway's
      const sandbox = createHarness([{ outcome: 'failed', step: 'content_fetch', error }]);

      // When the sandbox runs
      await sandbox.start(toFramedPage(createSandboxUrl())).await();

      // Then the failure screen shows the error's own message
      expect(sandbox.failures).toMatchObject([{ message }]);
    },
  );

  it('As a visitor, I cancel the password prompt and the operator sees it counted as expected, never captured', async () => {
    // Given a load the visitor ends by cancelling the password prompt
    const sandbox = createHarness([{ outcome: 'failed', step: 'decrypt', error: new DecryptionCancelledError() }]);

    // When
    await sandbox.start(toFramedPage(createSandboxUrl())).await();

    // Then
    expect(captured).toEqual([]);
    expect(expected).toMatchObject([{ step: 'decrypt' }]);
  });

  it('As a visitor leaving mid-load, I tear the frame down and the load shows and reports nothing', async () => {
    // Given
    const sandbox = createHarness([{ outcome: 'torn_down' }]);

    // When
    await sandbox.start(toFramedPage(createSandboxUrl())).await();

    // Then
    expect(sandbox.failures).toEqual([]);
    expect(captured).toEqual([]);
  });
});

describe('runSandbox retries', () => {
  const failed: LoadOutcome = { outcome: 'failed', step: 'content_fetch', error: new Error('unreachable') };

  it('As a visitor, I press retry and the product loads again as the next attempt', async () => {
    // Given
    const sandbox = createHarness([failed, { outcome: 'loaded' }]);
    await sandbox.start(toFramedPage(createSandboxUrl())).await();

    // When
    await sandbox.retry();

    // Then
    expect(sandbox.loads.map(load => load.attempt)).toEqual([1, 2]);
    expect(sandbox.events).toEqual(['configure paseo-next-v2', 'load 1', 'failed content_fetch', 'retrying', 'load 2']);
  });

  it('As a visitor, I press retry twice and the product loads once more, not twice', async () => {
    // Given a second load that is still running when retry is pressed again
    const sandbox = createHarness([failed]);
    const secondLoad = createDeferred<LoadOutcome>();
    const load = sandbox.deps.load;
    sandbox.deps.load = input => {
      if (input.attempt !== 2) {
        return load(input);
      }
      sandbox.loads.push(input);
      return secondLoad.promise;
    };
    await sandbox.start(toFramedPage(createSandboxUrl())).await();
    const retry = sandbox.failures[0]?.retry;
    if (retry === undefined) {
      throw new Error('no retry offered');
    }

    // When the same retry is pressed twice before the second load settles
    retry();
    retry();
    secondLoad.resolve({ outcome: 'loaded' });
    await sandbox.run.await();

    // Then the stale press neither loads nor shows a retry
    expect(sandbox.loads.map(entry => entry.attempt)).toEqual([1, 2]);
    expect(sandbox.events.filter(event => event === 'retrying')).toHaveLength(1);
  });

  it('As a visitor, I press the retry of an older failure after a later one and no load runs', async () => {
    // Given a first failure whose retry ran, and a second failure from that retry
    const sandbox = createHarness([failed]);
    await sandbox.start(toFramedPage(createSandboxUrl())).await();
    const olderRetry = sandbox.failures[0]?.retry;
    if (olderRetry === undefined) {
      throw new Error('no retry offered');
    }
    await sandbox.retry();

    // When the first failure's retry is pressed while the second failure is shown
    olderRetry();
    await sandbox.run.await();

    // Then the stale press neither loads nor shows a retry
    expect(sandbox.loads.map(entry => entry.attempt)).toEqual([1, 2]);
    expect(sandbox.events.filter(event => event === 'retrying')).toHaveLength(1);
  });

  it('As a visitor after five failed loads, I press retry and am asked to reload instead', async () => {
    // Given five failed loads
    const sandbox = createHarness([failed]);
    await sandbox.start(toFramedPage(createSandboxUrl())).await();
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
  });
});

describe('runSandbox broken dependencies', () => {
  it('As a visitor whose load rejects, I see an init failure with a retry, and the operator sees it reported', async () => {
    // Given a load that rejects instead of returning its outcome
    const sandbox = createHarness([{ outcome: 'loaded' }]);
    const broken = new Error('load blew up');
    sandbox.deps.load = () => Promise.reject(broken);

    // When
    await sandbox.start(toFramedPage(createSandboxUrl())).await();

    // Then
    expect(sandbox.events).toEqual(['configure paseo-next-v2', 'failed init']);
    expect(sandbox.failures).toMatchObject([{ step: 'init', title: 'Failed to load content' }]);
    expect(sandbox.failures[0]?.retry).toBeTypeOf('function');
    expect(captured).toMatchObject([{ error: broken, context: { step: 'init' } }]);
  });

  it('As a visitor whose failure cannot be shown, I still end the host loading screen, and the operator sees the throw', async () => {
    // Given a failed load whose error page throws
    const sandbox = createHarness([{ outcome: 'failed', step: 'content_fetch', error: new Error('unreachable') }]);
    const broken = new Error('error page blew up');
    sandbox.deps.ui.showError = () => {
      throw broken;
    };

    // When
    await sandbox.start(toFramedPage(createSandboxUrl())).await();

    // Then
    expect(sandbox.events).toEqual(['configure paseo-next-v2', 'load 1', 'failed content_fetch']);
    expect(captured).toMatchObject([
      { context: { step: 'content_fetch' } },
      { error: broken, context: { step: 'failure_show', tags: { failed_step: 'content_fetch' } } },
    ]);
  });

  it('As a visitor whose gateway host lookup throws, I still end the host loading screen, and the operator sees the throw', async () => {
    // Given a load that fails on an unreachable gateway, and a gateway host lookup that throws
    const sandbox = createHarness([
      {
        outcome: 'failed',
        step: 'content_fetch',
        error: setErrorName(new Error('IPFS gateway unreachable for bafy'), CONTENT_ERRORS.GATEWAY_UNREACHABLE),
      },
    ]);
    const broken = new Error('gateway host lookup blew up');
    sandbox.deps.getGatewayHost = () => {
      throw broken;
    };

    // When
    await sandbox.start(toFramedPage(createSandboxUrl())).await();

    // Then the host hears the failure, the load's failure is reported, and the throw is a defect of showing it
    expect(sandbox.events).toContain('failed content_fetch');
    expect(captured).toMatchObject([
      { context: { step: 'content_fetch' } },
      { error: broken, context: { step: 'failure_show' } },
    ]);
  });
});
