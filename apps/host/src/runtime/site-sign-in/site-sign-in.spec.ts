// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import { base64urlnopad } from '@scure/base';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import {
  blake2b,
  createSyncStore,
  deferred,
  fromHex,
  storeStatus,
  toHex,
  untilStatus,
  type ReadableStore,
} from '@dotli/shared';
import { must, recordLog } from '@dotli/shared/testing';
import { createSiteGrantStore, type SiteGrant, type SiteGrantStore } from '@dotli/storage';
import { memorySiteGrantsIdb } from '@dotli/storage/testing';
import type { ResponderState } from '../session-handoff/responder.js';
import type { MainAccount } from './main-account.js';
import type { SiteRequest } from './site-request.js';
import type { SiteRound, SiteScreen } from './site-round.js';
import { createSiteSignIn, siteSignInAction, type SiteSignInDeps } from './site-sign-in.js';
import { parsePublicSuffixList } from './public-suffix-list.js';
import type { SiteGroups } from './site-groups.js';

const ORIGIN = 'https://my-site.com';
const NOW = Date.parse('2026-10-23T15:00:00.000Z');

const MAIN_KEY = `0x${'a'.repeat(64)}`;
const OWNER = toHex(blake2b(fromHex(MAIN_KEY), 32));

const TOKEN = base64urlnopad.encode(new Uint8Array(32).fill(1));
const NEW_TOKEN = base64urlnopad.encode(new Uint8Array(32).fill(2));

/** The main account the window's core reports. */
const MAIN: MainAccount = { owner: OWNER, username: { name: 'alice.dot', kind: 'full' } };

const REQUEST: SiteRequest = { round: 'r1', siteToken: null, groupToken: null };

/** The registrable domains of a few rules of the Public Suffix List, as the window's loaded list gives them. */
const SUFFIXES = parsePublicSuffixList('com\nli\n');
const GROUPS: SiteGroups = { registrable: hostname => Promise.resolve(SUFFIXES.registrable(hostname)) };

function grantOf(fields: Partial<SiteGrant> = {}): SiteGrant {
  return {
    token: TOKEN,
    origin: ORIGIN,
    owner: OWNER,
    firstUsedAt: NOW - 1000,
    lastUsedAt: NOW - 1000,
    ...fields,
  };
}

/** One message the window posted to its opener. */
type Post =
  | { type: 'dotli:s:result'; result: unknown; site_token?: string }
  | { type: 'dotli:s:refused'; reason: string }
  | { type: 'dotli:s:cancelled' };

type HarnessOptions = {
  /** The site's origin, {@link ORIGIN} by default. */
  origin?: string;
  siteToken?: string | null;
  groupToken?: string | null;
  /** A grants store another round shares, in place of a new one. */
  store?: SiteGrantStore;
  /** Grants the main store keeps before the round. */
  grants?: SiteGrant[];
  /** Whether saving a grant fails. */
  saveFails?: boolean;
  /** The main account the window's core reports, {@link MAIN} by default. */
  main?: MainAccount;
};

/**
 * A site's sign-in over fakes: a responder that records what it posts and ends its round on its first terminal call, an
 * in-memory grants store, the main account the window's core reports, and a window flow the test says stored a sign-in
 * through.
 */
async function harness(options: HarnessOptions = {}) {
  const metrics = bindRecordingSentry({ onFinished: onTestFinished });
  const errors = recordLog({ onFinished: onTestFinished, level: 'error' });
  const origin = options.origin ?? ORIGIN;
  const posts: Post[] = [];
  const round = createSyncStore<ResponderState>('testSiteResponder', { kind: 'vetted', origin, party: 'third' });
  const end = (post: Post, state: ResponderState): void => {
    const { kind } = round.get();
    if (kind === 'answered' || kind === 'refused') {
      return;
    }
    posts.push(post);
    round.set(state);
  };
  const responder: SiteSignInDeps['responder'] = {
    state: round.get,
    subscribe: listener =>
      round.subscribe(() => {
        listener(round.get());
      }),
    send: (result, siteToken) => {
      end(
        {
          type: 'dotli:s:result',
          result,
          ...(siteToken === undefined ? {} : { site_token: siteToken }),
        },
        { kind: 'answered' },
      );
    },
    refuse: reason => {
      end({ type: 'dotli:s:refused', reason }, { kind: 'refused' });
    },
    cancel: () => {
      end({ type: 'dotli:s:cancelled' }, { kind: 'answered' });
    },
  };
  const stored = options.store ?? createSiteGrantStore(memorySiteGrantsIdb());
  for (const grant of options.grants ?? []) {
    await stored.save(grant);
  }
  const grants: SiteGrantStore = {
    ...stored,
    save: async grant => {
      if (options.saveFails === true) {
        throw new Error('The grants database is full');
      }
      await stored.save(grant);
    },
  };
  const windowFlows: { stored: () => void; close: () => void }[] = [];
  const closed = deferred<undefined>();
  const flow = createSiteSignIn({
    request: {
      ...REQUEST,
      siteToken: options.siteToken ?? null,
      groupToken: options.groupToken ?? null,
    },
    origin,
    self: 'https://dot.li',
    responder,
    grants,
    groups: GROUPS,
    mainAccount: () => Promise.resolve(options.main ?? MAIN),
    startWindowFlow: (stored, close) => {
      windowFlows.push({ stored, close });
    },
    now: () => NOW,
    randomToken: () => NEW_TOKEN,
    close: () => {
      closed.resolve(undefined);
    },
  });
  const views: SiteScreen['view'][] = [flow.screen.get().view];
  flow.screen.subscribe(() => {
    views.push(flow.screen.get().view);
  });
  return {
    flow,
    posts,
    stored,
    views,
    metrics,
    errors,
    closed: closed.promise,
    /** The window flow the site flow started, which the test says stored a sign-in through. */
    windowFlow: () => must(windowFlows[0], 'a started window flow'),
    /** Resolves once the screen shows `view`. */
    until: (view: SiteScreen['view']) => untilView(flow.screen, view),
  };
}

function untilView(screen: ReadableStore<SiteScreen>, view: SiteScreen['view']): Promise<void> {
  return untilStatus(storeStatus(screen), shown => shown.view === view);
}

function resultOf(posts: Post[]): Extract<Post, { type: 'dotli:s:result' }> {
  const [post] = posts;
  if (post?.type !== 'dotli:s:result') {
    throw new Error(`Expected one result, got ${JSON.stringify(posts)}`);
  }
  return post;
}

/** Consents on the consent view, and the window flow says a sign-in is stored. */
async function consentAndStore(flow: SiteRound, h: Awaited<ReturnType<typeof harness>>) {
  await h.until('consent');
  await flow.consent();
  h.windowFlow().stored();
}

describe('site sign-in', () => {
  it('As a user signing in to a new site, I consent and the site gets my username and a token', async () => {
    // Given a site the main store keeps no grant for, with no signer or phone in the round
    const h = await harness();

    // When the user consents and the window flow says a sign-in is stored
    await consentAndStore(h.flow, h);
    await h.closed;

    // Then the site gets the main account's username alone and a new token the main store keeps
    const post = resultOf(h.posts);
    expect(post.result).toEqual({ username: MAIN.username });
    expect(post.site_token).toBe(NEW_TOKEN);
    expect(await h.stored.list()).toEqual([
      { token: NEW_TOKEN, origin: ORIGIN, owner: OWNER, firstUsedAt: NOW, lastUsedAt: NOW },
    ]);
    expect(h.views).toEqual(['site-signing', 'consent', 'window', 'site-signing']);
    expect(h.flow.screen.get()).toEqual({ view: 'site-signing', origin: ORIGIN, route: 'auth' });
    expect(h.metrics.counted('session_pages.site_sign_in')).toEqual([{ outcome: 'granted', reason: 'new' }]);
  });

  it('As a user with no username, I sign in to the site and it gets an empty username', async () => {
    // Given a main account with no username
    const h = await harness({ main: { owner: OWNER, username: null } });

    // When the user consents and the window flow says a sign-in is stored
    await consentAndStore(h.flow, h);
    await h.closed;

    // Then the site gets an empty username and its token, and the grant is kept
    const post = resultOf(h.posts);
    expect(post.result).toEqual({ username: null });
    expect(post.site_token).toBe(NEW_TOKEN);
    expect(await h.stored.list()).toEqual([
      { token: NEW_TOKEN, origin: ORIGIN, owner: OWNER, firstUsedAt: NOW, lastUsedAt: NOW },
    ]);
  });

  it('As a user signing in to a site I signed in to before, I skip consent and the site gets my username at once', async () => {
    // Given a grant for this site and this main account
    const h = await harness({ siteToken: TOKEN, grants: [grantOf()] });

    // When the window flow says a sign-in is stored
    await h.until('window');
    h.windowFlow().stored();
    await h.closed;

    // Then no consent showed, the site got its username and no new token, and the grant's last use moved on
    expect(h.views).not.toContain('consent');
    const post = resultOf(h.posts);
    expect(post.result).toEqual({ username: MAIN.username });
    expect(post.site_token).toBeUndefined();
    expect(await h.stored.list()).toEqual([grantOf({ lastUsedAt: NOW })]);
    expect(h.metrics.counted('session_pages.site_sign_in')).toEqual([{ outcome: 'granted', reason: 'known' }]);
  });

  it('As a user with only a lite username, I sign in to the site with it', async () => {
    // Given a main account with only a lite username
    const h = await harness({ main: { owner: OWNER, username: { name: 'alice.01', kind: 'lite' } } });

    // When the round reads it
    await consentAndStore(h.flow, h);
    await h.closed;

    // Then the site gets the lite username
    expect(resultOf(h.posts).result).toEqual({ username: { name: 'alice.01', kind: 'lite' } });
  });

  it('As a site whose grant cannot be saved, I still get my result without a token and the failure is counted', async () => {
    // Given a grants store that cannot save
    const h = await harness({ saveFails: true });

    // When the round runs
    await consentAndStore(h.flow, h);
    await h.closed;

    // Then the site got its result with no token, nothing was kept, and the failed save was reported and counted
    const post = resultOf(h.posts);
    expect(post.result).toEqual({ username: MAIN.username });
    expect(post.site_token).toBeUndefined();
    expect(await h.stored.list()).toEqual([]);
    expect(h.errors).toHaveLength(1);
    expect(h.views).not.toContain('site-failed');
    expect(h.metrics.counted('session_pages.site_sign_in')).toEqual([
      { outcome: 'error', reason: 'grant' },
      { outcome: 'granted', reason: 'new' },
    ]);
  });
});

describe('site sign-in action', () => {
  it('As a site, I get the username of the main account the action runs for, with nothing shown or confirmed', async () => {
    // Given the sign-in action, and a round that records what the action shows or asks to confirm
    const action = siteSignInAction();
    const asked: string[] = [];

    // When the action runs for the main account
    const result = await action.run({
      main: MAIN,
      show: screen => {
        asked.push(screen.view);
      },
      confirmed: () => {
        asked.push('confirm');
        return Promise.resolve();
      },
      signal: new AbortController().signal,
    });

    // Then the result carries the main account's username alone, on the auth route, and nothing was shown or confirmed
    expect(result).toEqual({ username: MAIN.username });
    expect(asked).toEqual([]);
    expect(action.route).toBe('auth');
  });
});

describe('site sign-in of a group', () => {
  it('As a user signing in to two origins of a group, I give both one grant token', async () => {
    // Given a sign-in of one origin of the group the user consented to, whose token the other origin keeps
    const store = createSiteGrantStore(memorySiteGrantsIdb());
    const first = await harness({ store, groupToken: 'my group' });
    await consentAndStore(first.flow, first);
    await first.closed;
    const token = must(resultOf(first.posts).site_token, "the group's token");
    const second = await harness({
      store,
      origin: 'https://shop.my-site.com',
      siteToken: token,
      groupToken: 'my group',
    });

    // When the other origin signs in with that token
    await second.until('window');
    second.windowFlow().stored();
    await second.closed;

    // Then the other origin got no token of its own, and the one grant of that token holds both origins, with one
    // consent and the counts of a group
    expect(resultOf(second.posts).site_token).toBeUndefined();
    const kept = await store.list();
    expect(kept.map(grant => grant.token)).toEqual([token]);
    expect(must(kept[0], 'the one grant').group?.origins).toEqual(['https://my-site.com', 'https://shop.my-site.com']);
    expect(second.views).not.toContain('consent');
    expect(second.metrics.counted('session_pages.site_sign_in')).toEqual([{ outcome: 'granted', reason: 'group' }]);
  });
});
