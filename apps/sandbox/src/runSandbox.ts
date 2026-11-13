// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The sandbox's run: read the host's contract from the URL once, then load the product, and again on each retry the
// visitor asks for, up to a limit. Every failure is reported and shown.

import { hasLightClient } from '@dotli/config';
import type { SandboxContractError } from '@dotli/sandbox-wire';
import { createReporter, defineCount } from '@dotli/metrics';
import { createStateMachine, setErrorName, type MachineTypes, type Transition } from '@dotli/shared';

import { APP_LOG_TAG } from './appLogTag.js';
import type { HostMessages } from './createHostMessages.js';
import type { SandboxUi } from './createSandboxUi.js';
import {
  describeSandboxFailure,
  getFailureStep,
  type LoadDependency,
  type SandboxFailure,
} from './describeSandboxFailure.js';
import type { LoadInput, LoadOutcome, LoadStep, SandboxParams } from './loadProduct.js';
import { readSandboxContract, type SandboxContract, type SandboxPage } from './readSandboxContract.js';
import { appRunMetric } from './appRunMetric.js';
import { DecryptionCancelledError } from './errors.js';

const report = createReporter({ flow: 'content' });

/** Count. A transition of the sandbox run threw, a bug. Tagged `outcome` (error) and `reason` (the error's name). */
const runTransitionMetric = defineCount<'error'>('sandbox.run_transition');

/** The most loads in all, the first one and each retry. */
const MAX_ATTEMPTS = 5;

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
  /** Resolves once the host accepted the recover ask, and rejects once its deadline passed first. */
  waitForRecoverAccepted: () => Promise<void>;
  /** The IPFS gateway's host, named when it cannot be reached. */
  getGatewayHost: () => string | undefined;
  /** The host's root domain, whose `app.` subdomains serve products. */
  baseDomain: string;
};

/** A contract this sandbox cannot use, reported as the host's fault. */
type ContractFailure = Extract<SandboxFailure, { kind: 'offOrigin' | 'unreadable' }>;

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
  /** `cause` is what ended the wait: its deadline, or what the ask or the wait threw. */
  | { kind: 'recoverFailed'; cause: unknown }
  | { kind: 'loadSettled'; outcome: LoadOutcome }
  | { kind: 'loadRejected'; error: unknown }
  /** A press of the retry that the failure `from` offered. */
  | { kind: 'retried'; from: FailedRun };

/** What happened to the run, for its reports, and what it shows. */
type RunEffect =
  | { kind: 'configure'; params: SandboxParams }
  | { kind: 'topLevel' }
  /** `cause` is what the check or the ask threw, kept on the captured error. */
  | { kind: 'contractFailed'; failure: ContractFailure; cause: unknown }
  | { kind: 'recoverAsked'; reason: string }
  | { kind: 'recoverAccepted' }
  | { kind: 'loadRejected'; error: unknown }
  | { kind: 'loadFailed'; step: LoadStep; error: unknown; attempt: number; dependency: LoadDependency }
  | { kind: 'retryRefused' }
  /** Offers `retry` with the failure when given. */
  | { kind: 'showFailure'; failure: SandboxFailure; retry?: () => void }
  | { kind: 'showRetry' };

type RunMachine = MachineTypes<RunState, RunEvent, RunEffect>;

/**
 * Runs the sandbox: reads the host's contract from the URL, then loads the product, and again on each retry the
 * visitor asks for, up to a limit. A failure is shown, never thrown. Throws when `href` is no URL, or when the
 * contract check fails with anything but a contract error.
 */
export function runSandbox(page: SandboxPage, deps: RunSandboxDeps) {
  const machine = createStateMachine<RunMachine>({
    initial: { kind: 'starting' },
    handlers: {
      starting: {
        started(_state, { contract }, transition) {
          switch (contract.kind) {
            case 'topLevel':
              transition.emitState({ kind: 'ended' });
              transition.emitSideEffect({ kind: 'topLevel' });
              // A top-level load has no bridge for account, signing or storage calls, so it fails rather than half-works.
              transition.emitSideEffect({ kind: 'showFailure', failure: { kind: 'topLevel', host: contract.host } });
              return;
            case 'offOrigin':
              failContract({ kind: 'offOrigin' }, undefined, transition);
              return;
            case 'unreadable': {
              const { error } = contract;
              if (error.recoverable) {
                askHostToRecover(error, transition);
                return;
              }
              failContract({ kind: 'unreadable', step: 'contract_params', reason: error.message }, error, transition);
              return;
            }
            case 'readable':
              // Before the first load, which reads the settings it applies.
              transition.emitSideEffect({ kind: 'configure', params: contract.params });
              startAttempt(contract.params, 1, transition);
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
          failContract({ kind: 'unreadable', step: 'contract_rerender', reason: error.message }, cause, transition);
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
            transition.emitSideEffect({ kind: 'showFailure', failure: { kind: 'retryLimit', attempts: MAX_ATTEMPTS } });
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
          return deps.waitForRecoverAccepted();
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
    emitSideEffect({
      kind: 'showFailure',
      failure: { kind: 'load', step, error, dependency },
      retry: () => {
        update({ kind: 'retried', from: failedState });
      },
    });
  }

  /** Ends the run on a contract it cannot use. Reported, since that is the host's fault, never the visitor's. */
  function failContract(
    failure: ContractFailure,
    cause: unknown,
    { emitState, emitSideEffect }: Transition<RunMachine>,
  ): void {
    emitState({ kind: 'ended' });
    emitSideEffect({ kind: 'contractFailed', failure, cause });
    emitSideEffect({ kind: 'showFailure', failure });
  }

  /** Each effect becomes what the visitor sees, or the log line, count or capture it stands for. */
  function runEffect(effect: RunEffect): void {
    switch (effect.kind) {
      case 'configure':
        deps.configure(effect.params);
        return;
      case 'showFailure':
        showFailure(effect.failure, effect.retry);
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
        const { title, message } = describeSandboxFailure(effect.failure, deps);
        const error = setErrorName(new Error(`${title}: ${message}`, { cause: effect.cause }), 'SandboxContractError');
        report.capture(error, { step: getFailureStep(effect.failure), tags: { surface: 'sandbox_main' } });
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
        if (effect.error instanceof DecryptionCancelledError) {
          report.expected(effect.error, { step: effect.step, metric: appRunMetric, reason: 'decrypt_cancelled' });
          return;
        }
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
  function showFailure(failure: SandboxFailure, retry: (() => void) | undefined): void {
    const step = getFailureStep(failure);
    try {
      deps.hostMessages.notifyLoadingDone({ outcome: 'failed', failedStep: step });
      const { title, message } = describeSandboxFailure(failure, deps);
      deps.ui.showError(title, message, { retry });
    } catch (error) {
      report.defect(error, {
        step: 'failure_show',
        metric: appRunMetric,
        reason: 'show_threw',
        message: `${APP_LOG_TAG} Could not show the ${step} failure`,
        tags: { surface: 'sandbox_main', failed_step: step },
      });
    }
  }
}
