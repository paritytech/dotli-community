// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The screens a failed load ends on, and what their buttons do. The failure is already reported when it gets here.

import { withActiveTld, type Backend } from '@dotli/config';
import { log } from '@dotli/shared';
import type { DotliDebugEvent } from '@dotli/truapi-debug';
import type { Component } from 'solid-js';
import { SlidersIcon, type IconProps } from '@dotli/ui/icons';
import type { ShowErrorPage } from '@dotli/ui-widgets';
import type { ErrorDescription } from './errors.js';

export interface LoadFailure {
  /** The verdict the failure was reported under. */
  error: ErrorDescription;
  cause: unknown;
  label: string;
  backend: Backend;
}

/**
 * Which failure the previous attempt's recovery screen showed. A failure that survives a reload can offer a stronger
 * remedy.
 */
export interface ErrorSightings {
  seen: (kind: string) => boolean;
  remember: (kind: string) => void;
}

/**
 * The screens' button labels and reload icon. Given by the caller, since the boot chunks already hold them and importing
 * them here would split them out into boot chunks of their own.
 */
export interface FailureScreenCopy {
  reload: string;
  reloadIcon: Component<IconProps>;
  openSettings: string;
  tryAnyway: string;
  goBack: string;
  failover: Readonly<Record<'rpc-gateway' | 'smoldot-shared-worker', string>>;
}

export interface LoadFailureDeps {
  copy: FailureScreenCopy;
  /** Who the visitor trusts instead when they leave the light client, read when the warning shows. */
  trustedProviderHosts: () => string[];
  showErrorPage: ShowErrorPage;
  openSettings: () => void;
  /** The visitor's own retry. */
  reload: () => void;
  /** Reloads on the other backend. */
  switchBackend: (next: Backend) => void;
  /** Makes the next boot start the protocol frame on a clean chain database. */
  resetProtocolOnReload: () => void;
  sightings: ErrorSightings;
  emit: (event: DotliDebugEvent) => void;
}

/** Shows the failure's screen. Its buttons may move between screens, and none of them reports the failure again. */
export function presentLoadFailure(failure: LoadFailure, deps: LoadFailureDeps): void {
  const { error, backend } = failure;
  const { copy } = deps;
  if (error.recovery === 'none') {
    deps.showErrorPage({ title: error.title, detail: error.message, tips: error.tips });
    return;
  }
  if (error.recovery === 'reload') {
    deps.showErrorPage({
      title: error.title,
      detail: error.message,
      tips: error.tips,
      actions: [{ label: copy.reload, icon: copy.reloadIcon, onClick: deps.reload }],
    });
    return;
  }
  const nextBackend = backend === 'rpc-gateway' ? 'smoldot-shared-worker' : 'rpc-gateway';
  // A failed provider will fail again, while a failed light client is usually a transient peer problem.
  const failoverIsPrimary = backend === 'rpc-gateway';
  // The reload comes up on a fresh light client instead of the one that lost its subscription.
  const reloadForRecovery = (): void => {
    if (error.resetProtocol === true) {
      deps.resetProtocolOnReload();
    }
    deps.reload();
  };
  const commitFailover = (): void => {
    log.event('Transport switched after failure', { flow: 'resolve', from: backend, to: nextBackend });
    deps.emit({
      layer: 'failover',
      event: 'chain_backend',
      flowId:
        typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `fail-${String(Date.now())}`,
      timestamp: Date.now(),
      payload: {
        from: backend,
        to: nextBackend,
        reason: failure.cause instanceof Error ? failure.cause.message : 'resolution failed',
      },
    });
    deps.switchBackend(nextBackend);
  };
  // Dropping to a trusted provider gives up verification, so the user confirms it and staying put is primary.
  const showFailoverWarning = (): void => {
    deps.showErrorPage({
      glyph: 'warning',
      title: "Your connection won't be verified",
      detail: trustedProviderWarning(withActiveTld(failure.label), deps.trustedProviderHosts()),
      actions: [
        { label: copy.tryAnyway, onClick: commitFailover },
        { label: copy.goBack, primary: true, onClick: showResolutionError },
      ],
    });
  };
  // A first sighting points at Settings rather than offering a one-click drop to a trusted provider. A repeat of the
  // same failure earns the shortcut.
  const gateFailover = nextBackend === 'rpc-gateway' && !deps.sightings.seen(error.kind);
  function showResolutionError(): void {
    // Only the gated direction records a sighting. `unknown` never does, since two unrelated failures share it.
    if (nextBackend === 'rpc-gateway' && error.kind !== 'unknown') {
      deps.sightings.remember(error.kind);
    }
    deps.showErrorPage({
      title: error.title,
      detail: error.message,
      tips: error.tips,
      actions: [
        { label: copy.reload, icon: copy.reloadIcon, primary: !failoverIsPrimary, onClick: reloadForRecovery },
        gateFailover
          ? { label: copy.openSettings, icon: SlidersIcon, onClick: deps.openSettings }
          : {
              label: copy.failover[nextBackend],
              primary: failoverIsPrimary,
              onClick: nextBackend === 'rpc-gateway' ? showFailoverWarning : commitFailover,
            },
      ],
    });
  }
  showResolutionError();
}

/** Names only who vouches for the app, since that is what the visitor has to weigh. */
function trustedProviderWarning(domain: string, providers: readonly string[]): (string | { strong: string })[] {
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
