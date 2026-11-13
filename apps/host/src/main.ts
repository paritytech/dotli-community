// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The shell's entry. It reads the route from the URL, starts the host and opens what the route names.

// Must stay the first import: it starts Sentry before any other module evaluates.
import './boot.js';
import { startPage } from './startPage.js';
import { reportBootFailure } from './reportBootFailure.js';
// Its first imports load the host's startup modules and then mark the page's start, before the rest loads.
import { startShell, type Shell } from './startShell.js';
import { PAGE_START } from './pageStart.js';
import { openProduct } from './openProduct.js';
import { openTarget } from './openTarget.js';
import { bootTracker, type BootStep } from './createBootTracker.js';
import { holdNetworkWhileLoading } from './holdNetworkWhileLoading.js';
import { loadingState } from './state/loadingState.js';
import { networkPause } from './runtime/createNetworkPause.js';
import { urlPillState } from './state/urlPillState.js';
import { cidCache } from '@dotli/storage';
import { createStateMachine, type HandlerOf, type HandlersOf, type MachineTypes } from '@dotli/shared';
import { DEBUG, getNetwork, isLocalhost, LOCAL_ROOT } from '@dotli/config';
import { debugBus } from '@dotli/truapi-debug';
import { createReporter } from '@dotli/metrics';
import type { EarlyCidRead } from './createPageCidCache.js';
import { leaveForLanding, readLocalhostUrl, readShellRoute, type LocalTarget, type ShellRoute } from './shellRoute.js';
import { getShellPageRole, type PageRole } from './runtime/pageRole.js';
import { bindTopbar } from './bindTopbar.js';
import { bindUrlPill } from './bindUrlPill.js';

const bootReport = createReporter({ flow: 'boot' });

/** A route the page opens rather than leaves to its parent. */
type OpenedRoute = Exclude<ShellRoute, { kind: 'nested' }>;

/**
 * Where the page's boot is. It starts the shell, then opens what the route names: a local target by its URL, or a
 * product by its name. It ends opened, or failed once its failure screen shows.
 */
type BootState =
  | { kind: 'idle' }
  | { kind: 'startingShell'; route: OpenedRoute; cidRead: EarlyCidRead | null }
  | { kind: 'openingTarget'; target: LocalTarget; flowId: string }
  | { kind: 'openingProduct' }
  | { kind: 'opened' }
  | { kind: 'failed' };

type BootEvent =
  | { kind: 'started'; route: OpenedRoute; role: PageRole }
  | { kind: 'shellStarted'; shell: Shell }
  | { kind: 'opened' }
  | { kind: 'failed'; error: unknown };

/** What the boot reports: its step for a failure's tag, the route it took, a local target on screen, a failure. */
type BootEffect =
  | { kind: 'stepEntered'; step: BootStep }
  | { kind: 'routeAnnounced'; route: OpenedRoute; flowId: string }
  | { kind: 'targetRouted'; target: LocalTarget }
  | { kind: 'targetOpened'; target: LocalTarget; flowId: string }
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
        openingTarget,
        openingProduct,
        opened: null,
        failed: null,
      },
      onEffect: reportBoot,
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
const failBoot: HandlerOf<BootMachine, 'startingShell' | 'openingTarget' | 'openingProduct', 'failed'> = (
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
    switch (route.kind) {
      case 'preview':
      case 'localhost': {
        const proxied = isLocalhostProxy(route);
        emitState({ kind: 'openingTarget', target: route, flowId: shell.flowId });
        if (proxied) {
          emitSideEffect({ kind: 'routeAnnounced', route, flowId: shell.flowId });
        }
        emitSideEffect({ kind: 'stepEntered', step: proxied ? 'localhost_render' : 'preview_render' });
        emitSideEffect({ kind: 'targetRouted', target: route });
        update(
          openTarget(route, shell).then(
            () => ({ kind: 'opened' }),
            (error: unknown) => ({ kind: 'failed', error }),
          ),
        );
        return;
      }
      case 'product':
        emitState({ kind: 'openingProduct' });
        emitSideEffect({ kind: 'routeAnnounced', route, flowId: shell.flowId });
        emitSideEffect({ kind: 'stepEntered', step: 'resolve_setup' });
        update(
          openProduct({ route, shell, cidRead }).then(
            () => ({ kind: 'opened' }),
            (error: unknown) => ({ kind: 'failed', error }),
          ),
        );
        return;
      case 'landing':
        emitSideEffect({ kind: 'routeAnnounced', route, flowId: shell.flowId });
        try {
          leaveForLanding({ location: window.location, localRoot: LOCAL_ROOT });
        } catch (error) {
          update({ kind: 'failed', error });
          return;
        }
        emitState({ kind: 'opened' });
        return;
    }
  },
};

const openingTarget: HandlersOf<BootMachine, 'openingTarget'> = {
  failed: failBoot,
  opened({ target, flowId }, _event, { emitState, emitSideEffect }) {
    emitState({ kind: 'opened' });
    emitSideEffect({ kind: 'targetOpened', target, flowId });
  },
};

const openingProduct: HandlersOf<BootMachine, 'openingProduct'> = {
  failed: failBoot,
  opened(_state, _event, { emitState }) {
    emitState({ kind: 'opened' });
  },
};

/** Makes the boot's reports: the step a failure is tagged with, the debug panel's events and the failure screen. */
function reportBoot(effect: BootEffect): void {
  switch (effect.kind) {
    case 'stepEntered':
      bootTracker.setStep(effect.step);
      return;
    case 'routeAnnounced': {
      const { route } = effect;
      // With the path as the settings left it.
      debugBus.emit({
        layer: 'boot',
        event: 'url_parsed',
        flowId: effect.flowId,
        timestamp: Date.now(),
        payload: {
          label: route.kind === 'product' ? route.label : null,
          localhostHost: route.kind === 'localhost' ? route.host : null,
          deepPath: window.location.pathname + window.location.search,
        },
      });
      return;
    }
    case 'targetRouted':
      bootReport.log.event(isLocalhostProxy(effect.target) ? 'Route: localhost proxy' : 'Route: preview', {
        host: effect.target.host,
      });
      return;
    case 'targetOpened':
      performance.mark('dotli:main:end');
      if (isLocalhostProxy(effect.target)) {
        debugBus.emit({
          layer: 'boot',
          event: 'ready',
          flowId: effect.flowId,
          timestamp: Date.now(),
          payload: { label: null, totalMs: performance.now() - PAGE_START, path: 'localhost' },
        });
      }
      return;
    case 'failed':
      reportBootFailure(effect.error);
      return;
  }
}

/** Whether `target` is a local dev server behind the proxy. */
function isLocalhostProxy(target: LocalTarget): boolean {
  // Only debug builds read a localhost route, so the compile-time flag drops its branches from release bundles.
  return DEBUG && target.kind === 'localhost';
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
