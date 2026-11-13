// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The shell's entry. It reads the route from the URL, starts the host and opens what the route names.

// Must stay the first import: it starts Sentry before any other module evaluates.
import './boot.js';
import { startPage } from './startPage.js';
import { reportBootFailure } from './reportBootFailure.js';
// Its first imports load the host's startup modules and then mark the page's start, before the rest loads.
import { startShell, type Shell } from './startShell.js';
import { openProduct, type ProductToOpen } from './openProduct.js';
import { openTarget } from './openTarget.js';
import { holdNetworkWhileLoading } from './holdNetworkWhileLoading.js';
import { loadingState } from './state/loadingState.js';
import { networkPause } from './runtime/createNetworkPause.js';
import { cidCache } from '@dotli/storage';
import { createStateMachine, type HandlerOf, type HandlersOf, type MachineTypes } from '@dotli/shared';
import { DEBUG, getNetwork, isLocalhost, LOCAL_ROOT } from '@dotli/config';
import { leaveForLanding, readLocalhostUrl, readShellRoute, type ShellRoute } from './shellRoute.js';
import { getShellPageRole, type PageRole } from './runtime/pageRole.js';
import { bindTopbar } from './bindTopbar.js';
import { bindUrlPill } from './bindUrlPill.js';

/** A route the boot takes: every route but a nested one. */
type BootRoute = Exclude<ShellRoute, { kind: 'nested' }>;

/** A route the boot opens once the shell is up. A product's carries the CID cache read started for its name. */
type RouteToOpen = Exclude<BootRoute, { kind: 'product' }> | ProductToOpen;

/**
 * Where the page's boot is. It starts the shell, then opens what the route names: a local target by its URL, or a
 * product by its name, or leaves for the landing page. It ends opened once the opener resolves, which a product's load
 * that showed its own failure screen does too. Otherwise it ends left for the landing page, or failed once the boot's
 * failure screen shows.
 */
type BootState =
  | { kind: 'idle' }
  | { kind: 'startingShell'; route: RouteToOpen }
  | { kind: 'opening' }
  | { kind: 'opened' }
  | { kind: 'leftForLanding' }
  | { kind: 'failed' };

type BootEvent =
  | { kind: 'started'; route: BootRoute; role: PageRole }
  | { kind: 'shellStarted'; shell: Shell }
  | { kind: 'opened' }
  | { kind: 'failed'; error: unknown };

/** What the boot does: the move to the landing page, and the report of a failure. */
type BootEffect = { kind: 'leftForLanding' } | { kind: 'failed'; error: unknown };

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
    const toOpen = route.kind === 'product' ? { ...route, cidRead: cidCache.get(route.label, getNetwork()) } : route;
    emitState({ kind: 'startingShell', route: toOpen });
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
  shellStarted({ route }, { shell }, { emitState, emitSideEffect, update }) {
    if (route.kind === 'landing') {
      emitState({ kind: 'leftForLanding' });
      emitSideEffect({ kind: 'leftForLanding' });
      return;
    }
    emitState({ kind: 'opening' });
    const open = route.kind === 'product' ? openProduct(route, shell) : openTarget(route, shell);
    update(
      open.then(
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

/** Runs the boot's effects: the landing move and the failure screen. */
function runBootEffect(effect: BootEffect): void {
  switch (effect.kind) {
    case 'leftForLanding':
      leaveForLanding({ location: window.location, localRoot: LOCAL_ROOT });
      return;
    case 'failed':
      reportBootFailure(effect.error);
      return;
  }
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
