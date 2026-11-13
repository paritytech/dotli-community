// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A sign-in command the modal asks for, run on the page core once the bridge chunk loads and answered as the modal's
// event.

import { createReporter, defineCount } from '@dotli/metrics';
import { getErrorMessage, log } from '@dotli/shared';
import type { LoginOutcome, LoginParams } from './createAuthCommands.js';
import type { LogoutOutcome } from './createPageSignOut.js';
import type { AuthCommand, AuthModalEvent } from './signInRoute.js';

const report = createReporter({ flow: 'wallet' });

/**
 * Count. A sign-in command threw after the bridge chunk loaded. Tagged `outcome` (error), `reason` (the error's
 * name) and `step` (`login, logout, cancel_login`).
 */
const authCommandMetric = defineCount<'error'>('auth.command');

/** The page's sign-in and sign-out on its core. */
export type AuthCommands = {
  /**
   * Answers how the login ended. A click queued behind a login shares its answer. Answers `paired` at once for a user
   * already signed in. Rejects when the core paired but its session could not be stored or read back. A call queued
   * behind a login that rejects rejects too, with that failure as its cause.
   */
  login(params?: LoginParams): Promise<LoginOutcome>;
  /**
   * Settles once the sign-out has ended, with whether the phone heard of every session this page held. A failed
   * sign-out is reported and never rejects.
   */
  logout(): Promise<LogoutOutcome>;
  /**
   * Stops the pairing under way, at once and outside the queue, and ends the login round, so a later click logs in.
   * Never throws.
   */
  cancelLogin(): void;
};

/**
 * Runs `command` once `load` gives the commands, and answers its end as an event. The command reports its own failure,
 * and a failed login answers as `failureShown`. Never rejects.
 */
export async function runAuthCommand(command: AuthCommand, load: () => Promise<AuthCommands>): Promise<AuthModalEvent> {
  const message = `[dot.li auth] ${command.step} failed:`;
  let commands: AuthCommands;
  try {
    commands = await load();
  } catch (error) {
    // The getter resolves to the chunk boot already awaited, so a failure here is a wiring fault boot reported first.
    log.error(message, error);
    return getCommandFailure(command, error);
  }
  try {
    switch (command.step) {
      case 'login':
        await commands.login(command.params);
        break;
      case 'logout':
        await commands.logout();
        break;
      case 'cancel_login':
        commands.cancelLogin();
        break;
    }
    return { kind: 'commandEnded' };
  } catch (error) {
    const { step } = command;
    report.defect(error, { step, metric: authCommandMetric, message, attributes: { step } });
    return getCommandFailure(command, error);
  }
}

/** The event a failed command answers with: a failed login opens the modal at the error view. */
function getCommandFailure(command: AuthCommand, error: unknown): AuthModalEvent {
  switch (command.step) {
    case 'login':
      return { kind: 'failureShown', failure: 'Other', reason: getErrorMessage(error) };
    case 'logout':
    case 'cancel_login':
      return { kind: 'commandEnded' };
  }
}
