// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What a page is to sign-in, chosen once by its entry. Every page boots the same host, and the role alone tells them
// apart: where a sign-in runs, which wallet boots, how the signed-in flag is kept and how the restore rule counts.

import type { ShellRoute } from '../shell-route.js';
import type { PresenceReader } from './session/restore-rule.js';

/**
 * What a page is to sign-in.
 *
 * - `page`: a product, which signs in through the sign-in window, as its copy may not be the main store.
 * - `landing`: the landing page. It is served on the root domain, the protocol frame's own origin, so its copy is the
 *   main store in every browser. It pairs in place, and its sign-ins raise the root domain's flag.
 * - `preview`: a preview opened on its own. It is cross-origin isolated, whose opener policy cuts the link to any
 *   window it opens, so it pairs in place. Its copy is the main store, so its sign-ins raise the root domain's flag.
 * - `framed-preview`: a preview its preview host frames. It pairs in place too, and keeps its storage in that host's
 *   partition, so it leaves the root domain's flag alone.
 * - `signin-window`: the sign-in window, whose sign-ins raise the flag.
 * - `signout-window`: the sign-out window, which ends a stored session and shows none.
 */
export type PageRole = 'page' | 'landing' | 'preview' | 'framed-preview' | 'signin-window' | 'signout-window';

/**
 * Where a sign-in started on the page runs: in the sign-in window, or in the page's own sign-in modal. `self` is a
 * window, whose page is the sign-in or the sign-out itself, so it runs no modal.
 */
export type SignInSurface = 'window' | 'in-page' | 'self';

/** A shell page's role, from its route and whether another page frames it. */
export function shellPageRole(route: Pick<ShellRoute, 'kind'>, framed: boolean): PageRole {
  if (route.kind !== 'preview') {
    return 'page';
  }
  return framed ? 'framed-preview' : 'preview';
}

/**
 * A preview pairs in its own modal, since no window round can reach it, and the landing page does too, since it pairs
 * in the main store the window would.
 */
export function signInSurface(role: PageRole): SignInSurface {
  if (role === 'page') {
    return 'window';
  }
  return pairsOnly(role) ? 'self' : 'in-page';
}

/** Whether the page reads and writes the root domain's signed-in flag. */
export function sharesFlag(role: PageRole): boolean {
  return role !== 'framed-preview';
}

/**
 * Whether the page's sign-ins raise the flag: the pages that make sign-ins in the main store, the sign-in window, a
 * preview opened on its own and the landing page. Each owns the flag together with the main store. Any other page only
 * deletes it.
 */
export function ownsFlag(role: PageRole): boolean {
  return role === 'signin-window' || role === 'preview' || role === 'landing';
}

/**
 * Whether a set flag over the page's empty copy means a sign-in made elsewhere, which the page offers to continue.
 * Only the window resumes one, and a page that pairs in place either reads the main store itself, where such a flag is
 * stale, or shares no flag.
 */
export function offersResume(role: PageRole): boolean {
  return signInSurface(role) === 'window';
}

/** The windows boot only pairing cores and read a stored wallet as data, so nothing switches wallet mode or reloads. */
export function pairsOnly(role: PageRole): boolean {
  return role === 'signin-window' || role === 'signout-window';
}

/** Under which reader the restore rule on load counts what it drops. */
export function loadReader(role: PageRole): Extract<PresenceReader, 'load' | 'window'> {
  return pairsOnly(role) ? 'window' : 'load';
}

/** The sign-out window only ends the stored session, so it shows none. */
export function showsSession(role: PageRole): boolean {
  return role !== 'signout-window';
}

/**
 * A page's role, chosen once for the page's life. The singletons built on it read it once, so it is never reset.
 * Choosing the same role again is a no-op.
 */
export interface PageRoleSlot {
  /** Throws for a role other than the one chosen, as two boots on one page are wired wrong. */
  choose(role: PageRole): void;
  /** Throws before the boot chose it, as a module that reads it that early is wired wrong. */
  read(): PageRole;
}

export function createPageRoleSlot(): PageRoleSlot {
  let chosen: PageRole | null = null;
  return {
    choose(role) {
      if (chosen !== null && chosen !== role) {
        throw new Error(`Page role ${role} chosen after ${chosen}`);
      }
      chosen = role;
    },
    read() {
      if (chosen === null) {
        throw new Error('Page role read before the boot chose it');
      }
      return chosen;
    },
  };
}

const pageRoleSlot = createPageRoleSlot();

/** Sets the page's role, before anything reads it. */
export function choosePageRole(role: PageRole): void {
  pageRoleSlot.choose(role);
}

export function pageRole(): PageRole {
  return pageRoleSlot.read();
}
