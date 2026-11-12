// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The sandbox's run: read the host's contract from the URL once, then load the product, and again on each retry the
// visitor asks for, up to a limit. Every failure is reported and shown.

import { getLocalRoot, hasLightClient } from '@dotli/config';
import { CONTENT_ERRORS } from '@dotli/content';
import { SandboxContractError, validateSandboxParams } from '@dotli/sandbox-wire';
import { createReporter, defineCount } from '@dotli/metrics';
import {
  createStateMachine,
  describeGatewayUnreachable,
  getErrorMessage,
  getErrorName,
  realTimers,
  setErrorName,
  withTimeout,
  type HandlersOf,
  type MachineTypes,
  type Timers,
  type Transition,
} from '@dotli/shared';

import { APP_LOG_TAG } from './appLogTag.js';
import type { HostMessages } from './createHostMessages.js';
import type { SandboxUi } from './createSandboxUi.js';
import type { LoadInput, LoadOutcome, LoadStep, SandboxParams } from './loadProduct.js';
import { appRunMetric } from './appRunMetric.js';

const report = createReporter({ flow: 'content' });

/** Count. A transition of the sandbox run threw, a bug. Tagged `outcome` (error) and `reason` (the error's name). */
const runTransitionMetric = defineCount<'error'>('sandbox.run_transition');

type ContractStep = 'contract_top_level' | 'contract_origin' | 'contract_params' | 'contract_rerender';

/** Each step names the failure wherever it is reported. */
export type SandboxStep = LoadStep | ContractStep | 'retry_limit';

export type SandboxPage = {
  /** The page's URL, which carries the host's contract. */
  href: string;
  /** Whether the page runs in a frame, as the host renders it. */
  framed: boolean;
};

/**
 * What the run needs from the page. A throw from the host messages or the UI while a failure is shown, and a throw or
 * rejection from `load`, is reported and the run goes on. A throw from `configure` escapes the run.
 */
export type RunSandboxDeps = {
  /** Applies the contract's settings to the page, once, before the first load. */
  configure: (params: SandboxParams) => void;
  /** One load of the product. A rejection is reported and shown as a failed `init`. */
  load: (input: LoadInput) => Promise<LoadOutcome>;
  /** Ends the host's loading screen with the failed step, and asks the host to render this frame again. */
  hostMessages: Pick<HostMessages, 'notifyLoadingDone' | 'askRerender'>;
  /** Shows a failure, with a retry when one is offered, and that a retry started. */
  ui: Pick<SandboxUi, 'showError' | 'showRetryScreen'>;
  /** Resolves once the host accepted the recover ask, and rejects with `signal.reason` once `signal` aborts. */
  waitForRecoverAccepted: (signal: AbortSignal) => Promise<void>;
  /** The IPFS gateway's host, named when it cannot be reached. */
  getGatewayHost: () => string | undefined;
  /** The host's root domain, whose `app.` subdomains serve products. */
  baseDomain: string;
  /** How long the host has to accept the recover ask. */
  recoverTimeoutMs: number;
  /** The most loads in all, the first one and each retry. Five unless given. */
  maxAttempts?: number;
  /** The timers the wait for the host to accept the recover ask runs on. */
  timers?: Timers;
};

/** What the page's URL says about the host's contract. */
type Contract =
  | { kind: 'topLevel'; host: string }
  | { kind: 'offOrigin' }
  | { kind: 'unreadable'; error: SandboxContractError }
  | { kind: 'readable'; params: SandboxParams };

/** A failure the host is told of and the visitor is shown. */
type Failure = {
  step: SandboxStep;
  title: string;
  message: string;
  /** Offered with the failure when given. */
  retry?: (() => void) | undefined;
};

/** A contract this sandbox cannot use, reported as the host's fault. */
type ContractFailure = {
  step: ContractStep;
  title: string;
  /** Why the contract is unusable, shown and captured. */
  reason: string;
  /** What the check or the ask threw, kept on the captured error. */
  cause: unknown;
};

/**
 * Where the run is. It starts with the contract, waits for the host when the contract was stripped, then loads, and
 * waits for a retry after each failed attempt. It ends once a load ends or nothing more can run.
 */
type RunState =
  | { kind: 'starting' }
  | { kind: 'awaitingRecover'; wait: AbortController; error: SandboxContractError }
  | { kind: 'loading'; params: SandboxParams; attempt: number }
  | FailedRun
  | { kind: 'ended' };

type FailedRun = { kind: 'failed'; params: SandboxParams; attempt: number };

type RunEvent =
  | { kind: 'started'; contract: Contract }
  | { kind: 'recoverAccepted' }
  /** `cause` is what ended the wait: the contract the host never restored, or the error of a wait that could not start. */
  | { kind: 'recoverTimedOut'; cause: unknown }
  | { kind: 'loadSettled'; outcome: LoadOutcome }
  | { kind: 'loadRejected'; error: unknown }
  /** A press of the retry that the failure `from` offered. */
  | { kind: 'retried'; from: FailedRun };

/** What happened to the run, for its reports. */
type RunEffect =
  | { kind: 'topLevel' }
  | ({ kind: 'contractFailed' } & ContractFailure)
  | { kind: 'recoverAsked'; reason: string }
  | { kind: 'recoverAccepted' }
  | { kind: 'loadRejected'; error: unknown }
  | { kind: 'loadFailed'; step: LoadStep; error: unknown; attempt: number; dependency: string }
  | { kind: 'retryRefused'; maxAttempts: number }
  | { kind: 'showFailed'; step: SandboxStep; error: unknown };

type RunMachine = MachineTypes<RunState, RunEvent, RunEffect>;

/**
 * Runs the sandbox: reads the host's contract from the URL, then loads the product, and again on each retry the
 * visitor asks for, up to a limit. A failure is shown, never thrown. Throws when `href` is no URL, when the contract
 * check fails with anything but a contract error, or when `configure` throws.
 */
export function runSandbox(page: SandboxPage, deps: RunSandboxDeps) {
  const maxAttempts = deps.maxAttempts ?? 5;
  const timers = deps.timers ?? realTimers;
  const contract = readContract(page, deps.baseDomain);
  if (contract.kind === 'readable') {
    deps.configure(contract.params);
  }

  const starting: HandlersOf<RunMachine, 'starting'> = {
    started(_state, { contract: read }, transition) {
      switch (read.kind) {
        case 'topLevel':
          transition.emitState({ kind: 'ended' });
          transition.emitSideEffect({ kind: 'topLevel' });
          // A top-level load has no bridge for account, signing or storage calls, so it fails rather than half-works.
          showFailure(
            {
              step: 'contract_top_level',
              title: 'Sandbox URL not supported',
              message: `Open this dApp through https://${deps.baseDomain}. The sandbox origin (${read.host}) is not a standalone entry point.`,
            },
            transition,
          );
          return;
        case 'offOrigin':
          transition.emitState({ kind: 'ended' });
          failContract(
            {
              step: 'contract_origin',
              title: 'Sandbox URL not supported',
              reason: `This page must load as a dotns app subdomain (e.g. myapp.app.${deps.baseDomain}) through dot.li.`,
              cause: undefined,
            },
            transition,
          );
          return;
        case 'unreadable':
          if (read.error.recoverable) {
            askHostToRecover(read.error, transition);
            return;
          }
          transition.emitState({ kind: 'ended' });
          failContract(
            { step: 'contract_params', title: 'Invalid sandbox URL', reason: read.error.message, cause: read.error },
            transition,
          );
          return;
        case 'readable':
          startAttempt(read.params, 1, transition);
          return;
      }
    },
  };

  const awaitingRecover: HandlersOf<RunMachine, 'awaitingRecover'> = {
    recoverAccepted(_state, _event, { emitState, emitSideEffect }) {
      emitState({ kind: 'ended' });
      emitSideEffect({ kind: 'recoverAccepted' });
    },
    recoverTimedOut(state, { cause }, transition) {
      transition.emitState({ kind: 'ended' });
      state.wait.abort();
      failContract(
        { step: 'contract_rerender', title: 'Invalid sandbox URL', reason: state.error.message, cause },
        transition,
      );
    },
  };

  const loading: HandlersOf<RunMachine, 'loading'> = {
    loadSettled(state, { outcome }, transition) {
      switch (outcome.outcome) {
        case 'failed':
          failAttempt(
            { params: state.params, attempt: state.attempt, step: outcome.step, error: outcome.error },
            transition,
          );
          return;
        case 'loaded':
        case 'torn_down':
          transition.emitState({ kind: 'ended' });
          return;
      }
    },
    loadRejected(state, { error }, transition) {
      transition.emitSideEffect({ kind: 'loadRejected', error });
      failAttempt({ params: state.params, attempt: state.attempt, step: 'init', error }, transition);
    },
  };

  const failed: HandlersOf<RunMachine, 'failed'> = {
    retried(state, { from }, transition) {
      // A second press of a retry that already ran, or a retry from an older failure, asks for a load that already ran.
      if (from !== state) {
        return;
      }
      if (state.attempt >= maxAttempts) {
        transition.emitState({ kind: 'ended' });
        transition.emitSideEffect({ kind: 'retryRefused', maxAttempts });
        showFailure(
          {
            step: 'retry_limit',
            title: 'Too many retry attempts',
            message: `Reached ${String(maxAttempts)} failed attempts. Reload the page to start over.`,
          },
          transition,
        );
        return;
      }
      startAttempt(state.params, state.attempt + 1, transition);
    },
  };

  const machine = createStateMachine<RunMachine>({
    initial: { kind: 'starting' },
    handlers: { starting, awaitingRecover, loading, failed, ended: null },
    onEffect: reportRunEffect,
    onError: error => {
      report.defect(error, {
        step: 'run_transition',
        metric: runTransitionMetric,
        message: `${APP_LOG_TAG} A transition of the sandbox run threw`,
      });
    },
  });
  machine.update({ kind: 'started', contract });

  return {
    /** Resolves once no load and no wait for the host is in flight. */
    await: () => machine.await(),
  };

  /** Asks the host to render this frame again, and waits a bounded time for it to accept. */
  function askHostToRecover(error: SandboxContractError, transition: Transition<RunMachine>): void {
    const wait = new AbortController();
    transition.emitState({ kind: 'awaitingRecover', wait, error });
    // A reload of this window boots without the contract params, which were stripped after the last load. The host
    // can render it again with the params it last sent. Its rebuild can take long, so only an ask it never accepts
    // in time fails the load.
    try {
      deps.hostMessages.askRerender();
    } catch (askError) {
      transition.emitState({ kind: 'ended' });
      failContract(
        { step: 'contract_rerender', title: 'Invalid sandbox URL', reason: error.message, cause: askError },
        transition,
      );
      return;
    }
    transition.emitSideEffect({ kind: 'recoverAsked', reason: error.message });
    // In the same turn as the ask, since the host's answer arrives as a later message. The executor turns a wait that
    // throws as it starts into a rejection.
    const deadline = new Error('The host did not accept the recover ask in time');
    transition.update(
      withTimeout({
        work: new Promise<void>(resolve => {
          resolve(deps.waitForRecoverAccepted(wait.signal));
        }),
        ms: deps.recoverTimeoutMs,
        timers,
        timeoutError: () => deadline,
      }).then(
        () => ({ kind: 'recoverAccepted' }),
        (waitError: unknown) => ({ kind: 'recoverTimedOut', cause: waitError === deadline ? error : waitError }),
      ),
    );
  }

  function startAttempt(params: SandboxParams, attempt: number, { emitState, update }: Transition<RunMachine>): void {
    emitState({ kind: 'loading', params, attempt });
    // A retry shows that it started before its load runs.
    if (attempt > 1) {
      deps.ui.showRetryScreen();
    }
    update(
      new Promise<LoadOutcome>(resolve => {
        resolve(deps.load({ params, attempt }));
      }).then(
        outcome => ({ kind: 'loadSettled', outcome }),
        (error: unknown) => ({ kind: 'loadRejected', error }),
      ),
    );
  }

  function failAttempt(
    { params, attempt, step, error }: { params: SandboxParams; attempt: number; step: LoadStep; error: unknown },
    transition: Transition<RunMachine>,
  ): void {
    const failedState: FailedRun = { kind: 'failed', params, attempt };
    transition.emitState(failedState);
    const dependency = hasLightClient(params.backend) ? 'smoldot-bitswap' : 'ipfs-gateway';
    transition.emitSideEffect({ kind: 'loadFailed', step, error, attempt, dependency });
    // An unreachable gateway names a host the visitor can check, so it gets visitor copy.
    const message =
      dependency === 'ipfs-gateway' && getErrorName(error) === CONTENT_ERRORS.GATEWAY_UNREACHABLE
        ? describeGatewayUnreachable(deps.getGatewayHost())
        : `${getErrorMessage(error)} (via ${dependency})`;
    showFailure(
      {
        step,
        title: 'Failed to load content',
        message,
        retry: () => {
          transition.update({ kind: 'retried', from: failedState });
        },
      },
      transition,
    );
  }

  /** The host is told first, so a failure that cannot be shown still ends its loading screen. */
  function showFailure({ step, title, message, retry }: Failure, { emitSideEffect }: Transition<RunMachine>): void {
    try {
      deps.hostMessages.notifyLoadingDone({ outcome: 'failed', failedStep: step });
      deps.ui.showError(title, message, { retry });
    } catch (error) {
      emitSideEffect({ kind: 'showFailed', step, error });
    }
  }

  /** Reported, since a URL this sandbox cannot use is the host's fault, never the visitor's. */
  function failContract(failure: ContractFailure, transition: Transition<RunMachine>): void {
    transition.emitSideEffect({ kind: 'contractFailed', ...failure });
    showFailure({ step: failure.step, title: failure.title, message: failure.reason }, transition);
  }
}

/**
 * Reads the host's contract from `href`. Throws when `href` is no URL, or when the check fails with anything but a
 * contract error.
 */
function readContract({ href, framed }: SandboxPage, baseDomain: string): Contract {
  const url = new URL(href);
  if (!framed) {
    return { kind: 'topLevel', host: url.host };
  }
  // A bare `app.<root>` fails loudly.
  if (!isAppSubdomain(url.hostname, baseDomain)) {
    return { kind: 'offOrigin' };
  }
  // The sandbox cannot read the host's localStorage, so every setting arrives in the URL. A missing or invalid value
  // is a hard error, never a silent default. Extra keys are the user's own and pass through.
  try {
    return { kind: 'readable', params: validateSandboxParams(url.searchParams) };
  } catch (error) {
    if (!(error instanceof SandboxContractError)) {
      throw error;
    }
    return { kind: 'unreadable', error };
  }
}

/** The run's one runner of reports: each effect becomes the log line, count or capture it stands for. */
function reportRunEffect(effect: RunEffect): void {
  switch (effect.kind) {
    case 'topLevel':
      // A bookmark or a pasted link: the visitor's doing, not a defect.
      report.expected(new Error('Sandbox loaded as a top-level page'), {
        step: 'contract_top_level',
        metric: appRunMetric,
        reason: 'top_level',
      });
      return;
    case 'contractFailed': {
      const error = setErrorName(
        new Error(`${effect.title}: ${effect.reason}`, { cause: effect.cause }),
        'SandboxContractError',
      );
      report.capture(error, { step: effect.step, tags: { surface: 'sandbox_main' } });
      return;
    }
    case 'recoverAsked':
      report.log.event('Asking the host to re-render the sandbox', { reason: effect.reason });
      return;
    case 'recoverAccepted':
      report.log.event('The host accepted the recover ask');
      return;
    case 'loadRejected':
      report.log.error(`${APP_LOG_TAG} The load rejected instead of returning its outcome`, effect.error);
      appRunMetric.count({ outcome: 'error', reason: 'load_rejected' });
      return;
    case 'loadFailed':
      report.capture(effect.error, {
        step: effect.step,
        tags: { surface: 'sandbox_main', dependency: effect.dependency, attempt: String(effect.attempt) },
      });
      return;
    case 'retryRefused':
      report.log.warn(`${APP_LOG_TAG} Retry refused after ${String(effect.maxAttempts)} failed attempts`);
      return;
    case 'showFailed':
      report.defect(effect.error, {
        step: 'failure_show',
        metric: appRunMetric,
        reason: 'show_threw',
        message: `${APP_LOG_TAG} Could not show the ${effect.step} failure`,
        tags: { surface: 'sandbox_main', failed_step: effect.step },
      });
      return;
  }
}

/** Only confirms a `<label>.app.<root>` origin, since the CID arrives on the host contract. */
function isAppSubdomain(hostname: string, baseDomain: string): boolean {
  return hostname.endsWith(`.app.${getLocalRoot(hostname) ?? baseDomain}`);
}
