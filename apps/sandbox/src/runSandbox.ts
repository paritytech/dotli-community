// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The sandbox's run: read the host's contract from the URL once, then load the product, and again on each retry the
// visitor asks for, up to a limit. Every failure is reported and shown.

import { hasLightClient } from '@dotli/config';
import { CONTENT_ERRORS } from '@dotli/content';
import type { SandboxContractError } from '@dotli/sandbox-wire';
import { createReporter, defineCount } from '@dotli/metrics';
import {
  createStateMachine,
  describeGatewayUnreachable,
  getErrorMessage,
  getErrorName,
  realTimers,
  setErrorName,
  withTimeout,
  type MachineTypes,
  type Timers,
  type Transition,
} from '@dotli/shared';

import { APP_LOG_TAG } from './appLogTag.js';
import type { HostMessages } from './createHostMessages.js';
import type { SandboxUi } from './createSandboxUi.js';
import type { LoadInput, LoadOutcome, LoadStep, SandboxParams } from './loadProduct.js';
import { readSandboxContract, type SandboxContract, type SandboxPage } from './readSandboxContract.js';
import { appRunMetric } from './appRunMetric.js';

const report = createReporter({ flow: 'content' });

/** Count. A transition of the sandbox run threw, a bug. Tagged `outcome` (error) and `reason` (the error's name). */
const runTransitionMetric = defineCount<'error'>('sandbox.run_transition');

/** The most loads in all, the first one and each retry. */
const MAX_ATTEMPTS = 5;

type ContractStep = 'contract_top_level' | 'contract_origin' | 'contract_params' | 'contract_rerender';

/** Each step names the failure wherever it is reported. */
export type SandboxStep = LoadStep | ContractStep | 'retry_limit';

/**
 * What the run needs from the page. A throw from `configure`, from the host messages or the UI while a failure is
 * shown, and a throw or rejection from `load`, is reported and the run goes on.
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
  /** The timers the wait for the host to accept the recover ask runs on. */
  timers?: Timers;
};

/** The backend a load read its content through, named in its failure. */
type Dependency = 'smoldot-bitswap' | 'ipfs-gateway';

/** A failure the host is told of and the visitor is shown. A load's failure is worded as it is shown. */
type Failure =
  | { kind: 'worded'; step: SandboxStep; title: string; message: string }
  | { kind: 'load'; step: LoadStep; error: unknown; dependency: Dependency; retry: () => void };

/** A contract this sandbox cannot use, reported as the host's fault. */
type ContractFailure = {
  step: ContractStep;
  title: string;
  /** Why the contract is unusable, shown and captured. */
  message: string;
  /** What the check or the ask threw, kept on the captured error. */
  cause: unknown;
};

/**
 * Where the run is. It starts with the contract, waits for the host when the contract was stripped, then loads, and
 * waits for a retry after each failed attempt. It ends once a load ends or nothing more can run.
 */
type RunState =
  | { kind: 'starting' }
  | { kind: 'awaitingRecover'; error: SandboxContractError }
  | { kind: 'loading'; params: SandboxParams; attempt: number }
  | FailedRun
  | { kind: 'ended' };

type FailedRun = { kind: 'failed'; params: SandboxParams; attempt: number };

type RunEvent =
  | { kind: 'started'; contract: SandboxContract }
  | { kind: 'recoverAccepted' }
  /** `cause` is what ended the wait: the contract the host never restored, or what the ask or the wait threw. */
  | { kind: 'recoverFailed'; cause: unknown }
  | { kind: 'loadSettled'; outcome: LoadOutcome }
  | { kind: 'loadRejected'; error: unknown }
  /** A press of the retry that the failure `from` offered. */
  | { kind: 'retried'; from: FailedRun };

/** What happened to the run, for its reports, and what it shows. */
type RunEffect =
  | { kind: 'configure'; params: SandboxParams }
  | { kind: 'topLevel' }
  | ({ kind: 'contractFailed' } & ContractFailure)
  | { kind: 'recoverAsked'; reason: string }
  | { kind: 'recoverAccepted' }
  | { kind: 'loadRejected'; error: unknown }
  | { kind: 'loadFailed'; step: LoadStep; error: unknown; attempt: number; dependency: Dependency }
  | { kind: 'retryRefused' }
  | { kind: 'showFailure'; failure: Failure }
  | { kind: 'showRetry' };

type RunMachine = MachineTypes<RunState, RunEvent, RunEffect>;

/**
 * Runs the sandbox: reads the host's contract from the URL, then loads the product, and again on each retry the
 * visitor asks for, up to a limit. A failure is shown, never thrown. Throws when `href` is no URL, or when the
 * contract check fails with anything but a contract error.
 */
export function runSandbox(page: SandboxPage, deps: RunSandboxDeps) {
  const timers = deps.timers ?? realTimers;

  const machine = createStateMachine<RunMachine>({
    initial: { kind: 'starting' },
    handlers: {
      starting: {
        started(_state, { contract: read }, transition) {
          switch (read.kind) {
            case 'topLevel':
              transition.emitState({ kind: 'ended' });
              transition.emitSideEffect({ kind: 'topLevel' });
              // A top-level load has no bridge for account, signing or storage calls, so it fails rather than half-works.
              transition.emitSideEffect({
                kind: 'showFailure',
                failure: {
                  kind: 'worded',
                  step: 'contract_top_level',
                  title: 'Sandbox URL not supported',
                  message: `Open this dApp through https://${deps.baseDomain}. The sandbox origin (${read.host}) is not a standalone entry point.`,
                },
              });
              return;
            case 'offOrigin':
              transition.emitState({ kind: 'ended' });
              failContract(
                {
                  step: 'contract_origin',
                  title: 'Sandbox URL not supported',
                  message: `This page must load as a dotns app subdomain (e.g. myapp.app.${deps.baseDomain}) through dot.li.`,
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
                {
                  step: 'contract_params',
                  title: 'Invalid sandbox URL',
                  message: read.error.message,
                  cause: read.error,
                },
                transition,
              );
              return;
            case 'readable':
              // Before the first load, which reads the settings it applies.
              transition.emitSideEffect({ kind: 'configure', params: read.params });
              startAttempt(read.params, 1, transition);
              return;
          }
        },
      },
      awaitingRecover: {
        recoverAccepted(_state, _event, { emitState, emitSideEffect }) {
          emitState({ kind: 'ended' });
          emitSideEffect({ kind: 'recoverAccepted' });
        },
        recoverFailed({ error }, { cause }, transition) {
          transition.emitState({ kind: 'ended' });
          failContract(
            { step: 'contract_rerender', title: 'Invalid sandbox URL', message: error.message, cause },
            transition,
          );
        },
      },
      loading: {
        loadSettled(state, { outcome }, transition) {
          switch (outcome.outcome) {
            case 'failed':
              failAttempt(state, outcome, transition);
              return;
            case 'loaded':
            case 'torn_down':
              transition.emitState({ kind: 'ended' });
              return;
          }
        },
        loadRejected(state, { error }, transition) {
          transition.emitSideEffect({ kind: 'loadRejected', error });
          failAttempt(state, { step: 'init', error }, transition);
        },
      },
      failed: {
        retried(state, { from }, transition) {
          // A second press of a retry that already ran, or a retry from an older failure, asks for a load that already
          // ran.
          if (from !== state) {
            return;
          }
          if (state.attempt >= MAX_ATTEMPTS) {
            transition.emitState({ kind: 'ended' });
            transition.emitSideEffect({ kind: 'retryRefused' });
            transition.emitSideEffect({
              kind: 'showFailure',
              failure: {
                kind: 'worded',
                step: 'retry_limit',
                title: 'Too many retry attempts',
                message: `Reached ${String(MAX_ATTEMPTS)} failed attempts. Reload the page to start over.`,
              },
            });
            return;
          }
          startAttempt(state.params, state.attempt + 1, transition);
        },
      },
      ended: null,
    },
    onEffect: runEffect,
    onError: error => {
      report.defect(error, {
        step: 'run_transition',
        metric: runTransitionMetric,
        message: `${APP_LOG_TAG} A transition of the sandbox run threw`,
      });
    },
  });
  machine.update({ kind: 'started', contract: readSandboxContract(page, deps.baseDomain) });

  return {
    /** Resolves once no load and no wait for the host is in flight. */
    await: () => machine.await(),
  };

  /** Asks the host to render this frame again, and waits a bounded time for it to accept. */
  function askHostToRecover(
    error: SandboxContractError,
    { emitState, emitSideEffect, update }: Transition<RunMachine>,
  ): void {
    emitState({ kind: 'awaitingRecover', error });
    emitSideEffect({ kind: 'recoverAsked', reason: error.message });
    // A reload of this window boots without the contract params, which were stripped after the last load. The host
    // can render it again with the params it last sent. Its rebuild can take long, so only an ask it never accepts
    // in time fails the load. The wait starts with the ask, since the host's answer arrives as a later message.
    update(
      Promise.resolve()
        .then(() => {
          deps.hostMessages.askRerender();
          const wait = new AbortController();
          return withTimeout({
            work: deps.waitForRecoverAccepted(wait.signal),
            ms: deps.recoverTimeoutMs,
            timers,
            timeoutError: () => error,
          }).catch((cause: unknown) => {
            wait.abort();
            throw cause;
          });
        })
        .then(
          () => ({ kind: 'recoverAccepted' }),
          (cause: unknown) => ({ kind: 'recoverFailed', cause }),
        ),
    );
  }

  function startAttempt(
    params: SandboxParams,
    attempt: number,
    { emitState, emitSideEffect, update }: Transition<RunMachine>,
  ): void {
    emitState({ kind: 'loading', params, attempt });
    if (attempt > 1) {
      emitSideEffect({ kind: 'showRetry' });
    }
    // Started after the effects, so a retry shows that it started before its load runs. A `load` that throws before
    // it returns a promise rejects this one.
    update(
      Promise.resolve()
        .then(() => deps.load({ params, attempt }))
        .then(
          outcome => ({ kind: 'loadSettled', outcome }),
          (error: unknown) => ({ kind: 'loadRejected', error }),
        ),
    );
  }

  function failAttempt(
    { params, attempt }: Extract<RunState, { kind: 'loading' }>,
    { step, error }: { step: LoadStep; error: unknown },
    { emitState, emitSideEffect, update }: Transition<RunMachine>,
  ): void {
    const failedState: FailedRun = { kind: 'failed', params, attempt };
    emitState(failedState);
    const dependency = hasLightClient(params.backend) ? 'smoldot-bitswap' : 'ipfs-gateway';
    emitSideEffect({ kind: 'loadFailed', step, error, attempt, dependency });
    const retry = (): void => {
      update({ kind: 'retried', from: failedState });
    };
    emitSideEffect({ kind: 'showFailure', failure: { kind: 'load', step, error, dependency, retry } });
  }

  /** Reported, since a URL this sandbox cannot use is the host's fault, never the visitor's. */
  function failContract(failure: ContractFailure, { emitSideEffect }: Transition<RunMachine>): void {
    emitSideEffect({ kind: 'contractFailed', ...failure });
    emitSideEffect({
      kind: 'showFailure',
      failure: { kind: 'worded', step: failure.step, title: failure.title, message: failure.message },
    });
  }

  /** Each effect becomes what the visitor sees, or the log line, count or capture it stands for. */
  function runEffect(effect: RunEffect): void {
    switch (effect.kind) {
      case 'configure':
        deps.configure(effect.params);
        return;
      case 'showFailure':
        showFailure(effect.failure);
        return;
      case 'showRetry':
        deps.ui.showRetryScreen();
        return;
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
          new Error(`${effect.title}: ${effect.message}`, { cause: effect.cause }),
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
        report.log.warn(`${APP_LOG_TAG} Retry refused after ${String(MAX_ATTEMPTS)} failed attempts`);
        return;
    }
  }

  /** The host is told first, so a failure that cannot be worded or shown still ends its loading screen. */
  function showFailure(failure: Failure): void {
    try {
      deps.hostMessages.notifyLoadingDone({ outcome: 'failed', failedStep: failure.step });
      switch (failure.kind) {
        case 'worded':
          deps.ui.showError(failure.title, failure.message);
          return;
        case 'load':
          deps.ui.showError('Failed to load content', describeLoadFailure(failure), { retry: failure.retry });
          return;
      }
    } catch (error) {
      report.defect(error, {
        step: 'failure_show',
        metric: appRunMetric,
        reason: 'show_threw',
        message: `${APP_LOG_TAG} Could not show the ${failure.step} failure`,
        tags: { surface: 'sandbox_main', failed_step: failure.step },
      });
    }
  }

  /** An unreachable gateway names a host the visitor can check, so it gets visitor copy. */
  function describeLoadFailure({ error, dependency }: Extract<Failure, { kind: 'load' }>): string {
    if (dependency === 'ipfs-gateway' && getErrorName(error) === CONTENT_ERRORS.GATEWAY_UNREACHABLE) {
      return describeGatewayUnreachable(deps.getGatewayHost());
    }
    return `${getErrorMessage(error)} (via ${dependency})`;
  }
}
