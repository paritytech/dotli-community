// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The screens a failed load ends on, and what their buttons do. The failure is already reported when it gets here.

import { withActiveTld, type Backend } from '@dotli/config';
import { log, createRandomId, realTimers, type Timers } from '@dotli/shared';
import type { DotliDebugEvent } from '@dotli/truapi-debug';
import { RotateCwIcon, SlidersIcon } from '@dotli/ui/icons';
import type { ShowErrorPage } from '@dotli/ui';
import type { ErrorDescription } from './describeError.js';
import {
  FAILOVER_BTN_LABELS,
  GO_BACK_BTN_LABEL,
  OPEN_SETTINGS_BTN_LABEL,
  RELOAD_BTN_LABEL,
  TRY_ANYWAY_BTN_LABEL,
} from './errorCopy.js';

export type LoadFailure = {
  /** The verdict the failure was reported under. */
  error: ErrorDescription;
  cause: unknown;
  label: string;
  backend: Backend;
};

/**
 * Which failure the previous attempt's recovery screen showed. A failure that survives a reload can offer a stronger
 * remedy.
 */
export type ErrorSightings = {
  /** Returns whether the previous attempt's screen showed `kind`. Throws only as the store behind it does. */
  hasSeen: (kind: string) => boolean;
  /** Records `kind` as the failure this attempt's screen showed. Throws only as the store behind it does. */
  remember: (kind: string) => void;
};

type Params = {
  /** Who the visitor trusts instead when they leave the light client, read when the warning shows. */
  trustedProviderHosts: () => string[];
  /** Puts a full-page error screen up in place of whatever the page shows. */
  showErrorPage: ShowErrorPage;
  /** Opens the settings, where the visitor picks the backend. */
  openSettings: () => void;
  /** The visitor's own retry. */
  reload: () => void;
  /** Reloads on the other backend. */
  switchBackend: (next: Backend) => void;
  /** Makes the next boot start the protocol frame on a clean chain database. */
  resetProtocolOnReload: () => void;
  /** Which failure the previous attempt's screen showed. */
  sightings: ErrorSightings;
  /** Sends the backend switch to the debug panel. */
  emit: (event: DotliDebugEvent) => void;
  /** The clock the backend switch's debug event is stamped with. The page's own by default. */
  timers?: Pick<Timers, 'now'>;
};

/**
 * Shows the failure's screen. Its buttons may move between screens, and none of them reports the failure again. Throws
 * only as `params.showErrorPage` does.
 */
export function presentLoadFailure(failure: LoadFailure, params: Params): void {
  const { error, backend } = failure;
  const { timers = realTimers } = params;
  log.event('Error page shown', { flow: 'resolve', error_kind: error.kind, recovery: error.recovery });
  if (error.recovery === 'none') {
    params.showErrorPage({ title: error.title, detail: error.message, tips: error.tips });
    return;
  }
  if (error.recovery === 'reload') {
    params.showErrorPage({
      title: error.title,
      detail: error.message,
      tips: error.tips,
      actions: [{ label: RELOAD_BTN_LABEL, icon: RotateCwIcon, onClick: params.reload }],
    });
    return;
  }
  const nextBackend = backend === 'rpc-gateway' ? 'smoldot-shared-worker' : 'rpc-gateway';
  // A failed provider will fail again, while a failed light client is usually a transient peer problem.
  const failoverIsPrimary = backend === 'rpc-gateway';
  // The reload comes up on a fresh light client instead of the one that lost its subscription.
  function reloadForRecovery(): void {
    if (error.resetProtocol === true) {
      params.resetProtocolOnReload();
    }
    params.reload();
  }
  function commitFailover(): void {
    log.event('Transport switched after failure', { flow: 'resolve', from: backend, to: nextBackend });
    params.emit({
      layer: 'failover',
      event: 'chain_backend',
      flowId: createRandomId(),
      timestamp: timers.now(),
      payload: {
        from: backend,
        to: nextBackend,
        reason: failure.cause instanceof Error ? failure.cause.message : 'resolution failed',
      },
    });
    params.switchBackend(nextBackend);
  }
  // Dropping to a trusted provider gives up verification, so the user confirms it and staying put is primary.
  function showFailoverWarning(): void {
    params.showErrorPage({
      glyph: 'warning',
      title: "Your connection won't be verified",
      detail: getTrustedProviderWarning(withActiveTld(failure.label), params.trustedProviderHosts()),
      actions: [
        { label: TRY_ANYWAY_BTN_LABEL, onClick: commitFailover },
        { label: GO_BACK_BTN_LABEL, primary: true, onClick: showResolutionError },
      ],
    });
  }
  // A first sighting points at Settings rather than offering a one-click drop to a trusted provider. A repeat of the
  // same failure earns the shortcut.
  const gateFailover = nextBackend === 'rpc-gateway' && !params.sightings.hasSeen(error.kind);
  function showResolutionError(): void {
    // Only the gated direction records a sighting. `unknown` never does, since two unrelated failures share it.
    if (nextBackend === 'rpc-gateway' && error.kind !== 'unknown') {
      params.sightings.remember(error.kind);
    }
    params.showErrorPage({
      title: error.title,
      detail: error.message,
      tips: error.tips,
      actions: [
        { label: RELOAD_BTN_LABEL, icon: RotateCwIcon, primary: !failoverIsPrimary, onClick: reloadForRecovery },
        gateFailover
          ? { label: OPEN_SETTINGS_BTN_LABEL, icon: SlidersIcon, onClick: params.openSettings }
          : {
              label: FAILOVER_BTN_LABELS[nextBackend],
              primary: failoverIsPrimary,
              onClick: getFailoverStep(),
            },
      ],
    });
  }
  function getFailoverStep(): () => void {
    switch (nextBackend) {
      case 'rpc-gateway':
        return showFailoverWarning;
      case 'smoldot-shared-worker':
        return commitFailover;
    }
  }
  showResolutionError();
}

/** Names only who vouches for the app, since that is what the visitor has to weigh. */
function getTrustedProviderWarning(domain: string, providers: readonly string[]): (string | { strong: string })[] {
  const named = joinHosts(providers);
  return [
    { strong: domain },
    ` will load through ${named} instead of being verified by your browser. You will trust ${
      providers.length > 1 ? 'them' : named
    } to serve you the real app.`,
  ];
}

function joinHosts(hosts: readonly string[]): string {
  const last = hosts.at(-1);
  if (last === undefined) {
    return 'a trusted provider';
  }
  const rest = hosts.slice(0, -1);
  return rest.length === 0 ? last : `${rest.join(', ')} and ${last}`;
}
