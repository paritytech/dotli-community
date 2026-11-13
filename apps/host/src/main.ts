// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The shell's entry. It reads the route from the URL, starts the host and opens what the route names.

// Must stay the first import: it starts Sentry before any other module evaluates.
import './boot.js';
import { startPage } from './startPage.js';
import { reportBootFailure } from './reportBootFailure.js';
// Its first imports load the host's startup modules and then mark the page's start, before the rest loads.
import { startShell, type Shell } from './startShell.js';
import { openProduct } from './openProduct.js';
import { openTarget } from './openTarget.js';
import { holdNetworkWhileLoading } from './holdNetworkWhileLoading.js';
import { loadingState } from './state/loadingState.js';
import { networkPause } from './runtime/createNetworkPause.js';
import { urlPillState } from './state/urlPillState.js';
import { cidCache } from '@dotli/storage';
import { createStateMachine, type HandlerOf, type HandlersOf, type MachineTypes } from '@dotli/shared';
import { DEBUG, getNetwork, isLocalhost, LOCAL_ROOT } from '@dotli/config';
import { debugBus } from '@dotli/truapi-debug';
import type { EarlyCidRead } from './createPageCidCache.js';
import { leaveForLanding, readLocalhostUrl, readShellRoute, type ShellRoute } from './shellRoute.js';
import { getShellPageRole, type PageRole } from './runtime/pageRole.js';
import { bindTopbar } from './bindTopbar.js';
import { bindUrlPill } from './bindUrlPill.js';

/** A route the page opens rather than leaves to its parent. */
type OpenedRoute = Exclude<ShellRoute, { kind: 'nested' }>;

/**
 * Where the page's boot is. It starts the shell, then opens what the route names: a local target by its URL, or a
 * product by its name, or leaves for the landing page. It ends opened, or failed once its failure screen shows.
 */
type BootState =
  | { kind: 'idle' }
  | { kind: 'startingShell'; route: OpenedRoute; cidRead: EarlyCidRead | null }
  | { kind: 'opening' }
  | { kind: 'opened' }
  | { kind: 'leftForLanding' }
  | { kind: 'failed' };

type BootEvent =
  | { kind: 'started'; route: OpenedRoute; role: PageRole }
  | { kind: 'shellStarted'; shell: Shell }
  | { kind: 'opened' }
  | { kind: 'failed'; error: unknown };

/** What the boot reports and does: the route it took, the move to the landing page, a failure. */
type BootEffect =
  | { kind: 'routed'; route: OpenedRoute; flowId: string }
  | { kind: 'leftForLanding' }
  | { kind: 'failed'; error: unknown };

type BootMachine = MachineTypes<BootState, BootEvent, BootEffect>;

/** Starts the page and its boot on the route its URL names. A throw before the boot runs is reported. */
function main(): void {
  try {
    startPage();
    const framed = window.self !== window.top;
    const route = readShellRoute(window.location, {
      localhost: isLocalhost,
      framed,
      // Behind the compile-time flag, so release bundles drop the localhost proxy.
      readLocalhostProxyUrl: DEBUG ? readLocalhostUrl : undefined,
    });
    // A nested dot.li would draw a second topbar.
    if (route.kind === 'nested') {
      return;
    }
    performance.mark('dotli:main:start');
    // The load ends the hold itself once the loading screen is gone, so the stop goes unused.
    holdNetworkWhileLoading({ pause: networkPause, loading: loadingState.store });
    // From the URL alone, before any await, so the URL bar paints with the page.
    if (route.kind === 'preview' || route.kind === 'localhost') {
      urlPillState.showLocalhost(route.host);
    }
    const boot = createStateMachine<BootMachine>({
      initial: { kind: 'idle' },
      handlers: {
        idle,
        startingShell,
        opening,
        opened: null,
        leftForLanding: null,
        failed: null,
      },
      onEffect: runBootEffect,
      onError: reportBootFailure,
    });
    boot.update({ kind: 'started', route, role: getShellPageRole(route, framed) });
  } catch (error) {
    reportBootFailure(error);
  }
}

const idle: HandlersOf<BootMachine, 'idle'> = {
  started(_state, { route, role }, { emitState, update }) {
    const shellStart = startShell(route, role);
    // The network is final once the shell boot has started. `cidCache.get` never rejects, so the read needs no handler
    // even when the shell fails to start.
    const cidRead: EarlyCidRead | null =
      route.kind === 'product' ? { label: route.label, read: cidCache.get(route.label, getNetwork()) } : null;
    emitState({ kind: 'startingShell', route, cidRead });
    update(
      shellStart.then(
        shell => ({ kind: 'shellStarted', shell }),
        (error: unknown) => ({ kind: 'failed', error }),
      ),
    );
  },
};

/** Ends a boot that failed before the page had anything to show. */
const failBoot: HandlerOf<BootMachine, 'startingShell' | 'opening', 'failed'> = (
  _state,
  { error },
  { emitState, emitSideEffect },
) => {
  emitState({ kind: 'failed' });
  emitSideEffect({ kind: 'failed', error });
};

const startingShell: HandlersOf<BootMachine, 'startingShell'> = {
  failed: failBoot,
  shellStarted({ route, cidRead }, { shell }, { emitState, emitSideEffect, update }) {
    emitSideEffect({ kind: 'routed', route, flowId: shell.flowId });
    if (route.kind === 'landing') {
      emitState({ kind: 'leftForLanding' });
      emitSideEffect({ kind: 'leftForLanding' });
      return;
    }
    emitState({ kind: 'opening' });
    const opening = route.kind === 'product' ? openProduct({ route, shell, cidRead }) : openTarget(route, shell);
    update(
      opening.then(
        () => ({ kind: 'opened' }),
        (error: unknown) => ({ kind: 'failed', error }),
      ),
    );
  },
};

const opening: HandlersOf<BootMachine, 'opening'> = {
  failed: failBoot,
  opened(_state, _event, { emitState }) {
    emitState({ kind: 'opened' });
  },
};

/** Runs the boot's effects: the debug panel's route, the landing move and the failure screen. */
function runBootEffect(effect: BootEffect): void {
  switch (effect.kind) {
    case 'routed':
      // A preview is not announced.
      if (effect.route.kind !== 'preview') {
        announceRoute(effect.route, effect.flowId);
      }
      return;
    case 'leftForLanding':
      leaveForLanding({ location: window.location, localRoot: LOCAL_ROOT });
      return;
    case 'failed':
      reportBootFailure(effect.error);
      return;
  }
}

/** Tells the debug panel the route the URL named, with the path as the settings left it. */
function announceRoute(route: OpenedRoute, flowId: string): void {
  debugBus.emit({
    layer: 'boot',
    event: 'url_parsed',
    flowId,
    timestamp: Date.now(),
    payload: {
      label: route.kind === 'product' ? route.label : null,
      localhostHost: route.kind === 'localhost' ? route.host : null,
      deepPath: window.location.pathname + window.location.search,
    },
  });
}

// The shell's chrome is static markup that only this page renders, so its bindings run from this one script. They
// last the page's life, so their cleanups go unused.
const topbarElement = document.getElementById('topbar');
if (topbarElement !== null) {
  bindTopbar(topbarElement);
}
const urlPillElement = document.getElementById('topbar-url');
if (urlPillElement !== null) {
  bindUrlPill(urlPillElement);
}

main();
