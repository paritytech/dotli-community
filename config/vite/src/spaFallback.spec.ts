// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createLocalServing } from './createLocalServing.js';
import { getFallbackAction, type PageRequest } from './spaFallback.js';

type Params = {
  /** The hostname the page loads on. Defaults to a product host. */
  hostname?: string;
};

const PAGES = { landing: '/landing', session: '/session' };

/** The roots a development server answers on. */
const ROOTS = ['localhost', 'local.host'];

/** Returns a browser page load of `url`. */
function createPageLoad(url: string, { hostname = 'browse.localhost' }: Params = {}): PageRequest {
  return { method: 'GET', url, accept: 'text/html,application/xhtml+xml', hostname };
}

/** A public folder holding `paths`, which records every path a lookup asks for. */
function createPublicDir(...paths: string[]): { asked: string[]; isPublicFile: (path: string) => boolean } {
  const asked: string[] = [];

  function isPublicFile(path: string): boolean {
    asked.push(path);
    return paths.includes(path);
  }

  return { asked, isPublicFile };
}

describe('getFallbackAction', () => {
  it('As a visitor, I open the bare host and get the landing page with my query kept', () => {
    // Given a server for both local roots and a page load of the bare host with a query
    const { getRoute } = createLocalServing(ROOTS);
    const request = createPageLoad('/?ref=x', { hostname: 'localhost' });

    // When
    const action = getFallbackAction({ request, pages: PAGES, isPublicFile: createPublicDir().isPublicFile, getRoute });

    // Then
    expect(action).toEqual({ kind: 'rewrite', url: '/landing?ref=x' });
  });

  it('As a visitor, I follow a deep link on a product host and get the shell', () => {
    // Given a server for both local roots and a page load of a deep link on a product host
    const { getRoute } = createLocalServing(ROOTS);
    const request = createPageLoad('/some/page?tab=2');

    // When
    const action = getFallbackAction({ request, pages: PAGES, isPublicFile: createPublicDir().isPublicFile, getRoute });

    // Then
    expect(action).toEqual({ kind: 'rewrite', url: '/?tab=2' });
  });

  it('As a visitor, I open a public file and the dev server serves it', () => {
    // Given a server for both local roots and a public file whose name has a space
    const { getRoute } = createLocalServing(ROOTS);
    const files = createPublicDir('/manifest webmanifest.json');

    // When
    const action = getFallbackAction({
      request: createPageLoad('/manifest%20webmanifest.json'),
      pages: PAGES,
      isPublicFile: files.isPublicFile,
      getRoute,
    });

    // Then
    expect(action).toEqual({ kind: 'pass' });
    expect(files.asked).toEqual(['/manifest webmanifest.json']);
  });

  it('As a page, I fetch a script and the fallback leaves it alone without looking at the disk', () => {
    // Given a server for both local roots and a script fetch on a product host
    const { getRoute } = createLocalServing(ROOTS);
    const files = createPublicDir();
    const request: PageRequest = { method: 'GET', url: '/src/main.ts', accept: '*/*', hostname: 'browse.localhost' };

    // When
    const action = getFallbackAction({ request, pages: PAGES, isPublicFile: files.isPublicFile, getRoute });

    // Then
    expect(action).toEqual({ kind: 'pass' });
    expect(files.asked).toEqual([]);
  });

  it('As a visitor, I send a malformed escape and get a 404, not a server error', () => {
    // Given a server for both local roots and a page load with a malformed escape
    const { getRoute } = createLocalServing(ROOTS);
    const request = createPageLoad('/%E0%A4%A');

    // When
    const action = getFallbackAction({ request, pages: PAGES, isPublicFile: createPublicDir().isPublicFile, getRoute });

    // Then
    expect(action).toEqual({ kind: 'not-found' });
  });

  it('As a page, I load the protocol frame at /p/ and the fallback leaves it to the proxy', () => {
    // Given a server for both local roots and a page load of the protocol frame on the bare host
    const { getRoute } = createLocalServing(ROOTS);
    const request = createPageLoad('/p/', { hostname: 'localhost' });

    // When the fallback decides
    const action = getFallbackAction({ request, pages: PAGES, isPublicFile: createPublicDir().isPublicFile, getRoute });

    // Then it passes the request on
    expect(action).toEqual({ kind: 'pass' });
  });

  it('As a product page, I load /p/x on my host and the fallback gives me the shell', () => {
    // Given a server for both local roots and a page load of /p/x on a product host
    const { getRoute } = createLocalServing(ROOTS);
    const request = createPageLoad('/p/x', { hostname: 'browse.localhost' });

    // When the fallback decides
    const action = getFallbackAction({ request, pages: PAGES, isPublicFile: createPublicDir().isPublicFile, getRoute });

    // Then it rewrites to the shell
    expect(action).toEqual({ kind: 'rewrite', url: '/' });
  });

  it('As a user, I open /s/auth, /s/signout, /s/manage and /s/sign on the bare host and get the session window with my query kept', () => {
    // Given a server for both local roots and page loads of each session path on the bare host with a query
    const { getRoute } = createLocalServing(ROOTS);
    const requests = ['/s/auth', '/s/signout', '/s/manage', '/s/sign'].map(path =>
      createPageLoad(`${path}?debug=1`, { hostname: 'localhost' }),
    );

    // When the fallback decides for each
    const actions = requests.map(request =>
      getFallbackAction({ request, pages: PAGES, isPublicFile: createPublicDir().isPublicFile, getRoute }),
    );

    // Then it rewrites each to the session window with the query
    expect(actions).toEqual([
      { kind: 'rewrite', url: '/session?debug=1' },
      { kind: 'rewrite', url: '/session?debug=1' },
      { kind: 'rewrite', url: '/session?debug=1' },
      { kind: 'rewrite', url: '/session?debug=1' },
    ]);
  });

  it('As a user, I open a percent-encoded /s/auth on the bare host and get the session window like the built server does', () => {
    // Given a server for both local roots and a page load of /s/%61uth on the bare host
    const { getRoute } = createLocalServing(ROOTS);
    const request = createPageLoad('/s/%61uth', { hostname: 'localhost' });

    // When the fallback decides
    const action = getFallbackAction({ request, pages: PAGES, isPublicFile: createPublicDir().isPublicFile, getRoute });

    // Then it rewrites to the session window
    expect(action).toEqual({ kind: 'rewrite', url: '/session' });
  });

  it('As a visitor, I open a path near the session windows on the bare host and get the shell, not the session window', () => {
    // Given page loads on the bare host of a trailing slash, another path under the segment and the old path
    const { getRoute } = createLocalServing(ROOTS);
    const requests = ['/s/auth/', '/s/other', '/__session'].map(path =>
      createPageLoad(path, { hostname: 'localhost' }),
    );

    // When the fallback decides for each
    const actions = requests.map(request =>
      getFallbackAction({ request, pages: PAGES, isPublicFile: createPublicDir().isPublicFile, getRoute }),
    );

    // Then it rewrites each to the shell
    expect(actions).toEqual([
      { kind: 'rewrite', url: '/' },
      { kind: 'rewrite', url: '/' },
      { kind: 'rewrite', url: '/' },
    ]);
  });

  it('As a user on local.host, I open /s/auth on the bare local.host and get the session window', () => {
    // Given a server for both local roots and a page load of the session window on the bare local.host
    const { getRoute } = createLocalServing(ROOTS);
    const request = createPageLoad('/s/auth?debug=1', { hostname: 'local.host' });

    // When the fallback decides
    const action = getFallbackAction({ request, pages: PAGES, isPublicFile: createPublicDir().isPublicFile, getRoute });

    // Then it rewrites to the session window
    expect(action).toEqual({ kind: 'rewrite', url: '/session?debug=1' });
  });

  it('As a visitor on local.host, I open a product subdomain of it and get the shell, not the landing page', () => {
    // Given a server for both local roots and a page load of a product subdomain of local.host
    const { getRoute } = createLocalServing(ROOTS);
    const request = createPageLoad('/', { hostname: 'browse.local.host' });

    // When the fallback decides
    const action = getFallbackAction({ request, pages: PAGES, isPublicFile: createPublicDir().isPublicFile, getRoute });

    // Then it passes the request on to the shell
    expect(action).toEqual({ kind: 'pass' });
  });

  it('As a visitor, I follow /s/auth and /s/signout on a product host and get the shell, as only the bare host has them', () => {
    // Given a server for both local roots and page loads of both session paths on a product host
    const { getRoute } = createLocalServing(ROOTS);
    const requests = [createPageLoad('/s/auth?debug=1'), createPageLoad('/s/signout?debug=1')];

    // When the fallback decides for each
    const actions = requests.map(request =>
      getFallbackAction({ request, pages: PAGES, isPublicFile: createPublicDir().isPublicFile, getRoute }),
    );

    // Then it rewrites both to the shell with the query
    expect(actions).toEqual([
      { kind: 'rewrite', url: '/?debug=1' },
      { kind: 'rewrite', url: '/?debug=1' },
    ]);
  });
});
