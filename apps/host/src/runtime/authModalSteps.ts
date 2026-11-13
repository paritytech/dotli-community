// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The sign-in modal's steps that the auth controller and its route share. Each moves the modal through the transition
// it runs in, and none reaches the machine.

import { withActiveTld } from '@dotli/config';
import type { Transition } from '@dotli/shared';
import type { AuthModalView } from '../state/authModalState.js';
import type { BlockingModalCoordinator } from './createBlockingModalCoordinator.js';
import { getLoginFailureView } from './getLoginFailureView.js';
import {
  isLeaseDisabled,
  isLeaseHeld,
  type AuthCommand,
  type AuthModalEvent,
  type AuthModalMachine,
  type LiveModal,
  type OpenAuthModalParams,
} from './signInRoute.js';

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
   * Opens the modal on its spinner and returns the state it leaves, queued for the screen in a scope of its own when it
   * was closed. Returns null when the modal is disabled, having cancelled the core's login.
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
    // A "localhost:<port>" label is a local dev server in localhost-proxy mode, shown as-is.
    let productLabel: string | null = null;
    if (label !== undefined && label.length > 0) {
      productLabel = label.startsWith('localhost:') || dotSuffix === false ? label : withActiveTld(label);
    }
    transition.emitSideEffect({
      kind: 'modalReset',
      productLabel,
      reason: reason !== undefined && reason.length > 0 ? reason : null,
    });
    const reset: LiveModal = { ...state, view: { kind: 'spinner' } };
    if (isLeaseHeld(state.lease)) {
      transition.emitState(reset);
      return reset;
    }
    const scope = coordinator.createScope();
    const queued: LiveModal = { ...reset, lease: { kind: 'queued', scope } };
    transition.emitState(queued);
    transition.emitSideEffect({ kind: 'leaseQueued', scope });
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

/** Moves `state` to show `view` in the modal. */
export function showView(
  state: LiveModal,
  view: AuthModalView,
  { emitState, emitSideEffect }: Transition<AuthModalMachine>,
): void {
  emitState({ ...state, view });
  emitSideEffect({ kind: 'viewShown', view });
}
