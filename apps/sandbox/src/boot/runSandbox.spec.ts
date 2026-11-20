// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest';

import { SANDBOX_SCHEMA_VERSION, type SandboxContractMessage } from '@dotli/sandbox-wire';
import { bindCaptureSink, type CaptureContext } from '@dotli/metrics';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import { CONTENT_ERRORS } from '@dotli/content';
import { bindLogSink, createDeferred, setErrorName } from '@dotli/shared';

import type { HostMessages } from '../hostLink/createHostMessages.js';
import type { LoadInput, LoadOutcome } from './loadProduct.js';
import type { SandboxPage } from './readSandboxFraming.js';
import type { SandboxAction } from '../screens/createSandboxUi.js';
import type { SandboxStep } from './describeSandboxFailure.js';
import { DecryptionCancelledError } from '../kit/errors.js';
import { runSandbox, type RunSandboxDeps } from './runSandbox.js';

type Failure = {
  step: SandboxStep;
  title: string;
  message: string;
  action: SandboxAction | undefined;
};

type Run = ReturnType<typeof runSandbox>;

/** A failure, the action it offers, and what pressing that action does. */
type ActionCase = {
  cause: string;
  page: SandboxPage;
  outcomes: LoadOutcome[];
  /** The host's reply to the contract request, when the run gets far enough to ask. */
  contract?: (() => Promise<SandboxContractMessage>) | undefined;
  goal: string;
  /** The last thing the run did once the action was pressed. */
  event: string;
  loads: number;
};

type HarnessOptions = {
  /** The host's reply to the contract request. Resolves a valid contract unless the case needs otherwise. */
  contract?: (() => Promise<SandboxContractMessage>) | undefined;
  askNavigate?: HostMessages['askNavigate'] | undefined;
};

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
  /** Presses the action of the latest failure. Resolves once the run has settled. */
  press: () => Promise<void>;
};

const CID = 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy';

/** A framed sandbox URL on a product subdomain, which clears the run to ask its host for the contract. */
function createSandboxUrl({ host = 'myapp.app.localhost' }: { host?: string } = {}): string {
  return `https://${host}/`;
}

/** The host's contract reply, as it rides the handshake, with `overrides` for the field a case bends. */
function createContractMessage(overrides: Partial<SandboxContractMessage> = {}): SandboxContractMessage {
  return {
    type: 'dotli:sandbox-contract',
    v: String(SANDBOX_SCHEMA_VERSION),
    cid: CID,
    chainBackend: 'rpc-gateway',
    network: 'paseo-next-v2',
    ...overrides,
  };
}

/**
 * A sandbox whose every load ends with the next of `outcomes`, then with the last one, and whose host replies to the
 * contract request with a valid contract unless `contract` says otherwise. `askNavigate` replaces its ask to the host.
 */
function createHarness(outcomes: LoadOutcome[], { contract, askNavigate }: HarnessOptions = {}): Harness {
  const loads: LoadInput[] = [];
  const failures: Failure[] = [];
  const events: string[] = [];
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
    requestContract: contract ?? (() => Promise.resolve(createContractMessage())),
    hostMessages: {
      notifyLoadingDone(result) {
        if (result.outcome === 'failed') {
          events.push(`failed ${result.failedStep}`);
          failures.push({ step: result.failedStep, title: '', message: '', action: undefined });
        }
      },
      askNavigate:
        askNavigate ??
        (to => {
          events.push(`navigate ${to}`);
        }),
    },
    tab: {
      openApp: () => {
        events.push('open app');
      },
      openLanding: () => {
        events.push('open landing');
      },
    },
    ui: {
      showError(title, message, { action } = {}) {
        const shown = failures.at(-1);
        if (shown !== undefined) {
          Object.assign(shown, { title, message, action });
        }
      },
      showRetryScreen: () => {
        events.push('retrying');
      },
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
    press: pressLatest,
  };

  function pressLatest(): Promise<void> {
    const action = failures.at(-1)?.action;
    if (action === undefined || started === undefined) {
      throw new Error('the latest failure offers no action');
    }
    action.onClick();
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
    // Given a host whose reply pins the wrong contract version
    const sandbox = createHarness([{ outcome: 'loaded' }], {
      contract: () => Promise.resolve(createContractMessage({ v: '999' })),
    });

    // When
    await sandbox.start(toFramedPage(createSandboxUrl())).await();

    // Then
    expect(sandbox.failures).toMatchObject([{ step: 'contract_params', title: "Couldn't start the app" }]);
    expect(captured).toMatchObject([
      {
        error: { name: 'SandboxContractError', cause: { name: 'SandboxContractError', recoverable: false } },
        context: { step: 'contract_params' },
      },
    ]);
    expect(sandbox.loads).toEqual([]);
  });

  it('As an operator whose host omits a required contract field, I see it fail terminally with no recover path', async () => {
    // Given a host whose reply is missing the content id, a field a reload once recovered
    const sandbox = createHarness([{ outcome: 'loaded' }], {
      contract: () =>
        Promise.resolve({
          type: 'dotli:sandbox-contract',
          v: String(SANDBOX_SCHEMA_VERSION),
          chainBackend: 'rpc-gateway',
          network: 'paseo-next-v2',
        }),
    });

    // When
    await sandbox.start(toFramedPage(createSandboxUrl())).await();

    // Then the once-recoverable error is now terminal, reported at contract_params, and offers only a reload
    expect(sandbox.failures).toMatchObject([{ step: 'contract_params', action: { label: 'Reload' } }]);
    expect(captured).toMatchObject([
      { error: { cause: { name: 'SandboxContractError', recoverable: true } }, context: { step: 'contract_params' } },
    ]);
    expect(sandbox.loads).toEqual([]);
  });

  it('As a visitor whose host never delivers the contract, I see the handshake fail as the host’s fault', async () => {
    // Given a host that never replies, so the handshake wait rejects at its deadline
    const deadline = new Error('The host did not deliver the sandbox contract within 6000ms');
    const sandbox = createHarness([{ outcome: 'loaded' }], { contract: () => Promise.reject(deadline) });

    // When
    await sandbox.start(toFramedPage(createSandboxUrl())).await();

    // Then
    expect(sandbox.failures).toMatchObject([
      {
        step: 'contract_handshake',
        title: "Couldn't start the app",
        message: 'The host did not deliver the sandbox contract.',
      },
    ]);
    expect(captured).toMatchObject([
      { error: { name: 'SandboxContractError', cause: deadline }, context: { step: 'contract_handshake' } },
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
    expect(sandbox.loads).toEqual([]);
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
});

describe('runSandbox load failures', () => {
  it('As an operator, I watch a load fail and see it reported with its step, its backend and its attempt', async () => {
    // Given a host whose contract selects the light-client backend
    const error = new Error('bitswap_v1_get failed (code=-32602): invalid');
    const sandbox = createHarness([{ outcome: 'failed', step: 'content_fetch', error }], {
      contract: () => Promise.resolve(createContractMessage({ chainBackend: 'smoldot-direct' })),
    });

    // When
    await sandbox.start(toFramedPage(createSandboxUrl())).await();

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
    await sandbox.press();

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
    const retry = sandbox.failures[0]?.action?.onClick;
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
    const olderRetry = sandbox.failures[0]?.action?.onClick;
    if (olderRetry === undefined) {
      throw new Error('no retry offered');
    }
    await sandbox.press();

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
      await sandbox.press();
    }

    // When
    await sandbox.press();

    // Then
    expect(sandbox.loads).toHaveLength(5);
    expect(sandbox.failures.at(-1)).toMatchObject({
      step: 'retry_limit',
      title: 'Too many retry attempts',
      message: 'Reached 5 failed attempts. Reload the page to start over.',
    });
  });
});

describe('runSandbox failure actions', () => {
  const archiveIndexFailed: LoadOutcome = {
    outcome: 'failed',
    step: 'archive_index',
    error: new Error('no index.html in the archive'),
  };

  it.each<ActionCase>([
    {
      cause: 'a load whose archive index failed',
      page: toFramedPage(createSandboxUrl()),
      outcomes: [archiveIndexFailed],
      goal: 'the host opens its landing and nothing loads again',
      event: 'navigate landing',
      loads: 1,
    },
    {
      cause: 'a contract this sandbox cannot read',
      page: toFramedPage(createSandboxUrl()),
      outcomes: [],
      contract: () => Promise.resolve(createContractMessage({ v: '999' })),
      goal: 'the host reloads its page',
      event: 'navigate reload',
      loads: 0,
    },
    {
      cause: 'a frame off its app origin',
      page: toFramedPage(createSandboxUrl({ host: 'app.dot.li' })),
      outcomes: [],
      goal: 'dot.li opens apart from the frame',
      event: 'open landing',
      loads: 0,
    },
    {
      cause: 'the sandbox URL opened as the page',
      page: { href: createSandboxUrl(), framed: false },
      outcomes: [],
      goal: 'the tab moves to the product on dot.li',
      event: 'open app',
      loads: 0,
    },
  ])('As a visitor facing $cause, I press its action and $goal', async ({ page, outcomes, contract, event, loads }) => {
    // Given a failure on screen
    const sandbox = createHarness(outcomes, { contract });
    await sandbox.start(page).await();

    // When its action is pressed
    await sandbox.press();

    // Then
    expect({ event: sandbox.events.at(-1), loads: sandbox.loads.length }).toEqual({ event, loads });
  });

  it('As a visitor whose failure action throws, I keep the failure on screen, and the operator sees the throw', async () => {
    // Given a failure whose ask to the host throws
    const broken = new Error('The host window is gone');
    const sandbox = createHarness([archiveIndexFailed], {
      askNavigate: () => {
        throw broken;
      },
    });
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    await sandbox.start(toFramedPage(createSandboxUrl())).await();

    // When its action is pressed
    await sandbox.press();

    // Then the throw is a defect of the action, and the failure is still the latest screen
    expect(captured).toMatchObject([
      { context: { step: 'archive_index' } },
      { error: broken, context: { step: 'failure_action' } },
    ]);
    expect(sentry.counted('app.run')).toEqual([{ outcome: 'error', reason: 'action_threw' }]);
    expect(sandbox.failures.map(failure => failure.step)).toEqual(['archive_index']);
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
    expect(sandbox.failures[0]?.action?.onClick).toBeTypeOf('function');
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
