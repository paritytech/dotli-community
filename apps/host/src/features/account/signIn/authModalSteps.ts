// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The sign-in modal's steps that the auth controller and its route share. Each works through the transition it runs in,
// and none reaches the machine.

import { createReporter, defineCount } from '@dotli/metrics';
import type { Transition } from '@dotli/shared';
import type { AuthModalView } from './authModalState.js';
import type { BlockingModalCoordinator, BlockingModalScope } from '../../../kit/createBlockingModalCoordinator.js';
import { getLoginFailureView } from './getLoginFailureView.js';
import { toProductId } from '../../../kit/getAskedProductId.js';
import {
  isLeaseDisabled,
  isLeaseHeld,
  type AuthCommand,
  type AuthModalEvent,
  type AuthModalMachine,
  type LiveModal,
  type OpenAuthModalParams,
} from './signInRoute.js';

const report = createReporter({ flow: 'wallet' });

/**
 * Count. The sign-in modal's lease failed other than by its own abort. Tagged `outcome` (error) and `reason` (the
 * error's name).
 */
const authModalLeaseMetric = defineCount<'error'>('auth.modal_lease');

type Params = {
  /** Where the modal's leases come from. */
  coordinator: BlockingModalCoordinator;
  /** Runs a sign-in command on the core, and answers its end as an event. Never rejects. */
  runCommand: (command: AuthCommand) => Promise<AuthModalEvent>;
};

/** The modal's steps, as their factory builds them. */
export type ModalSteps = ReturnType<typeof createModalSteps>;

/** Builds the steps that open the modal, which take their leases from `coordinator`. */
export function createModalSteps({ coordinator, runCommand }: Params) {
  /** Runs `command` on the core, whose end comes back to the machine. */
  function run(command: AuthCommand, transition: Transition<AuthModalMachine>): void {
    transition.update(runCommand(command));
  }

  /**
   * Opens the modal on its spinner and returns the state for the caller to emit, queued for the screen in a scope of its
   * own when it was closed. Returns null when the modal is disabled, having cancelled the core's login.
   */
  function open(
    state: LiveModal,
    { reason, label, dotSuffix }: OpenAuthModalParams,
    transition: Transition<AuthModalMachine>,
  ): LiveModal | null {
    if (isLeaseDisabled(state.lease)) {
      run({ step: 'cancel_login' }, transition);
      return null;
    }
    // The modal names the product by the id it asks for, unless its label opts out of the TLD.
    let productLabel: string | null = null;
    if (label !== undefined && label.length > 0) {
      productLabel = dotSuffix === false ? label : toProductId(label);
    }
    transition.emitSideEffect({
      kind: 'modalReset',
      productLabel,
      reason: reason !== undefined && reason.length > 0 ? reason : null,
    });
    const reset: LiveModal = { ...state, view: { kind: 'spinner' } };
    if (isLeaseHeld(state.lease)) {
      return reset;
    }
    const scope = coordinator.createScope();
    const queued: LiveModal = { ...reset, lease: { kind: 'queued', scope } };
    queueLease(scope, transition);
    return queued;
  }

  /** Opens the modal at the error view of a failed sign-in. */
  function showFailure(
    state: LiveModal,
    { failure, reason }: Pick<Extract<AuthModalEvent, { kind: 'failureShown' }>, 'failure' | 'reason'>,
    transition: Transition<AuthModalMachine>,
  ): void {
    const opened = open(state, {}, transition);
    if (opened === null) {
      return;
    }
    showView(opened, getLoginFailureView(failure, reason), transition);
  }

  return { run, open, showFailure };
}

/**
 * Waits for the screen in the blocking-modal queue and sends the grant through `update`. The grant holds the screen
 * until it is released or its scope ends.
 */
function queueLease(scope: BlockingModalScope, { update }: Pick<Transition<AuthModalMachine>, 'update'>): void {
  void scope
    .enqueue(
      signal =>
        new Promise<void>(release => {
          // A scope disposed while the modal is open frees the queue with no event.
          signal.addEventListener(
            'abort',
            () => {
              release();
            },
            { once: true },
          );
          update({ kind: 'leaseGranted', scope, signal, release });
        }),
    )
    .catch((error: unknown) => {
      // Closing the modal disposes its lease, which rejects with an AbortError.
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        report.defect(error, {
          step: 'auth_modal_lease',
          metric: authModalLeaseMetric,
          message: '[dot.li auth] authentication modal lease failed:',
        });
      }
    });
}

/** Moves `state` to show `view` in the modal. */
export function showView(
  state: LiveModal,
  view: AuthModalView,
  { emitState, emitSideEffect }: Transition<AuthModalMachine>,
): void {
  emitState({ ...state, view });
  emitSideEffect({ kind: 'viewShown', view });
}
