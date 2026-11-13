// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The shell's entry. It reads the route from the URL, starts the host and opens what the route names.

// Must stay the first import: it starts Sentry before any other module evaluates.
import './boot.js';
import { startPage } from './startPage.js';
import { reportBootFailure } from './reportBootFailure.js';
// Its first imports load the host's startup modules and then mark the page's start, before the rest loads.
import { startShell } from './startShell.js';
import { openProduct } from './openProduct.js';
import { openTarget } from './openTarget.js';
import { holdNetworkWhileLoading } from './holdNetworkWhileLoading.js';
import { loadingState } from './state/loadingState.js';
import { networkPause } from './runtime/createNetworkPause.js';
import { cidCache } from '@dotli/storage';
import { DEBUG, getNetwork, isLocalhost, LOCAL_ROOT } from '@dotli/config';
import { leaveForLanding, readLocalhostUrl, readShellRoute } from './shellRoute.js';
import { getShellPageRole } from './runtime/pageRole.js';
import { bindTopbar } from './bindTopbar.js';
import { bindUrlPill } from './bindUrlPill.js';

/**
 * Starts the page and the shell on the route its URL names, then opens what the route names: a local target by its
 * URL, a product by its name, or the landing page elsewhere. Resolves once the opener does, which a product's load that
 * showed its own failure screen does too. Rejects with what failed before the page had anything to show.
 */
async function main(): Promise<void> {
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
  const shellStart = startShell(route, getShellPageRole(route, framed));
  // The network is final once the shell boot has started. `cidCache.get` never rejects, so the read needs no handler
  // even when the shell fails to start.
  const toOpen = route.kind === 'product' ? { ...route, cidRead: cidCache.get(route.label, getNetwork()) } : route;
  const shell = await shellStart;
  if (toOpen.kind === 'landing') {
    leaveForLanding({ location: window.location, localRoot: LOCAL_ROOT });
    return;
  }
  await (toOpen.kind === 'product' ? openProduct(toOpen, shell) : openTarget(toOpen, shell));
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

main().catch(reportBootFailure);
