// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The grant a site's round reads for the site's token, the group it judges for the site's group token, and the grant it
// keeps once the user granted the round.

import type { SiteGrant, SiteGrantStore } from '@dotli/storage';
import type { SiteGroups } from './createSiteGroups.js';

/** A site's group: its registrable domain and its group token. */
export type SiteGroup = {
  registrable: string;
  token: string;
};

/** How the request's group was judged: by its registrable domains, or not at all for a request of no group. */
export type GroupLookup =
  | { kind: 'none' }
  | { kind: 'read'; token: string; registrable: string | null; own: string | null }
  | { kind: 'failed'; error: unknown };

/** The grant the site's token names, or why it could not be read. */
export type GrantLookup = { kind: 'read'; grant: SiteGrant | null } | { kind: 'failed'; error: unknown };

/** How keeping the round's grant ended. `kept` is the grant whose token the site gets, or null when it gets none. */
export type GrantKeep =
  | { kind: 'grantKept'; kept: SiteGrant | null }
  | { kind: 'grantKeepFailed'; error: unknown; reason: 'grant_touch' | 'grant' };

type LookUpParams = {
  request: { siteToken: string | null; groupToken: string | null };
  /** The site's origin. */
  origin: string;
  /** The window's own origin, whose registrable domain no site's group may have. */
  self: string;
  grants: Pick<SiteGrantStore, 'read'>;
  groups: SiteGroups;
};

type KeepParams = {
  grants: Pick<SiteGrantStore, 'touch' | 'save' | 'saveGroup'>;
  /** The site's origin. */
  origin: string;
  group: SiteGroup | null;
  /** The grant the site's token named, which answers the request's group and the main account. */
  known: SiteGrant | null;
  /** The main account's owner, whose grant a new one is. */
  owner: string;
  /** The time the grant's use is stamped with. */
  at: number;
  /** A new grant's site token. */
  randomToken: () => string;
};

/**
 * Judges the request's group while it reads the grant the site's token names. Never rejects: a failed read or judging
 * is its lookup's `failed`.
 */
export function lookUpSite({
  request: { siteToken, groupToken },
  origin,
  self,
  grants,
  groups,
}: LookUpParams): Promise<{ group: GroupLookup; grant: GrantLookup }> {
  const reading: Promise<GrantLookup> = (siteToken === null ? Promise.resolve(null) : grants.read(siteToken)).then(
    grant => ({ kind: 'read', grant }),
    (error: unknown) => ({ kind: 'failed', error }),
  );
  const judging: Promise<GroupLookup> =
    groupToken === null
      ? Promise.resolve({ kind: 'none' })
      : Promise.all([groups.registrable(new URL(origin).hostname), groups.registrable(new URL(self).hostname)]).then(
          ([registrable, own]) => ({ kind: 'read', token: groupToken, registrable, own }),
          (error: unknown) => ({ kind: 'failed', error }),
        );
  return Promise.all([judging, reading]).then(([group, grant]) => ({ group, grant }));
}

/**
 * Whether `grant` answers the request: one of the request's group, or of `origin` for a request of no group. Its owner
 * is checked once the main account is read.
 */
export function isAnsweringGrant(grant: SiteGrant, group: SiteGroup | null, origin: string): boolean {
  return group === null
    ? grant.group === undefined && grant.origin === origin
    : grant.group?.registrable === group.registrable && grant.group.token === group.token;
}

/**
 * Keeps a new grant, or moves a known one's last use on and joins this origin to its group. Resolves with the grant
 * whose token the site gets for a new grant, the group's own when the group already has one, or none for a known
 * grant. Never rejects.
 */
export function keepGrant({ grants, origin, group, known, owner, at, randomToken }: KeepParams): Promise<GrantKeep> {
  if (known !== null) {
    // A known grant answers the request's group and the main account, so this origin may join it.
    const touching = group === null ? grants.touch(known.token, at) : grants.touch(known.token, at, { origin });
    return touching.then(
      () => ({ kind: 'grantKept', kept: null }),
      (error: unknown) => ({ kind: 'grantKeepFailed', error, reason: 'grant_touch' }),
    );
  }
  const kept: SiteGrant = { token: randomToken(), origin, owner, firstUsedAt: at, lastUsedAt: at };
  // Kept before the site gets the token, so no site holds a token the main store does not know.
  const saving =
    group === null
      ? grants.save(kept).then(() => kept)
      : grants.saveGroup({ ...kept, group: { ...group, origins: [origin] } });
  return saving.then(
    saved => ({ kind: 'grantKept', kept: saved }),
    (error: unknown) => ({ kind: 'grantKeepFailed', error, reason: 'grant' }),
  );
}

/** The reason the round's outcome counts with. */
export function getGrantReason(group: SiteGroup | null, known: SiteGrant | null): string {
  if (group !== null) {
    return 'group';
  }
  return known === null ? 'new' : 'known';
}

/**
 * Whether a kept grant whose token never reached the site is forgotten. A group's grant stays, since the user consented
 * and another origin of the group may hold its token.
 */
export function isUnsentGrantForgotten(grant: Pick<SiteGrant, 'group'>): boolean {
  return grant.group === undefined;
}
