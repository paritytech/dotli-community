// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createLocalServing } from './serving.js';
import { fallbackFor, type PageRequest } from './spa-fallback.js';

const PAGES = { landing: '/landing', session: '/session' };

/** The roots a development server answers on. */
const ROOTS = ['localhost', 'local.host'];

/** A browser page load of `url` on `hostname`. */
function pageLoad(url: string, hostname = 'browse.localhost'): PageRequest {
  return { method: 'GET', url, accept: 'text/html,application/xhtml+xml', hostname };
}

/** A public folder holding `paths`, which records every path a lookup asks for. */
function publicDir(...paths: string[]): { asked: string[]; isPublicFile: (path: string) => boolean } {
  const asked: string[] = [];
  return {
    asked,
    isPublicFile: path => {
      asked.push(path);
      return paths.includes(path);
    },
  };
}

describe('fallbackFor', () => {
  it('As a visitor, I open the bare host and get the landing page with my query kept', () => {
    // Given a server for both local roots and a page load of the bare host with a query
    const { routeFor } = createLocalServing(ROOTS);
    const req = pageLoad('/?ref=x', 'localhost');

    // When
    const action = fallbackFor(req, PAGES, publicDir().isPublicFile, routeFor);

    // Then
    expect(action).toEqual({ kind: 'rewrite', url: '/landing?ref=x' });
  });

  it('As a visitor, I follow a deep link on a product host and get the shell', () => {
    // Given a server for both local roots and a page load of a deep link on a product host
    const { routeFor } = createLocalServing(ROOTS);
    const req = pageLoad('/some/page?tab=2');

    // When
    const action = fallbackFor(req, PAGES, publicDir().isPublicFile, routeFor);

    // Then
    expect(action).toEqual({ kind: 'rewrite', url: '/?tab=2' });
  });

  it('As a visitor, I open a public file and the dev server serves it', () => {
    // Given a server for both local roots and a public file whose name has a space
    const { routeFor } = createLocalServing(ROOTS);
    const files = publicDir('/manifest webmanifest.json');

    // When
    const action = fallbackFor(pageLoad('/manifest%20webmanifest.json'), PAGES, files.isPublicFile, routeFor);

    // Then
    expect(action).toEqual({ kind: 'pass' });
    expect(files.asked).toEqual(['/manifest webmanifest.json']);
  });

  it('As a page, I fetch a script and the fallback leaves it alone without looking at the disk', () => {
    // Given a server for both local roots and a script fetch on a product host
    const { routeFor } = createLocalServing(ROOTS);
    const files = publicDir();
    const req: PageRequest = { method: 'GET', url: '/src/main.ts', accept: '*/*', hostname: 'browse.localhost' };

    // When
    const action = fallbackFor(req, PAGES, files.isPublicFile, routeFor);

    // Then
    expect(action).toEqual({ kind: 'pass' });
    expect(files.asked).toEqual([]);
  });

  it('As a visitor, I send a malformed escape and get a 404, not a server error', () => {
    // Given a server for both local roots and a page load with a malformed escape
    const { routeFor } = createLocalServing(ROOTS);
    const req = pageLoad('/%E0%A4%A');

    // When
    const action = fallbackFor(req, PAGES, publicDir().isPublicFile, routeFor);

    // Then
    expect(action).toEqual({ kind: 'not-found' });
  });

  it('As a page, I load the protocol frame at /__protocol/ and the fallback leaves it to the proxy', () => {
    // Given a server for both local roots and a page load of the protocol frame on the bare host
    const { routeFor } = createLocalServing(ROOTS);
    const req = pageLoad('/__protocol/', 'localhost');

    // When the fallback decides
    const action = fallbackFor(req, PAGES, publicDir().isPublicFile, routeFor);

    // Then it passes the request on
    expect(action).toEqual({ kind: 'pass' });
  });

  it('As a user, I open /__session on the bare host and get the session page with my query kept', () => {
    // Given a server for both local roots and a page load of the sign-in window on the bare host with a query
    const { routeFor } = createLocalServing(ROOTS);
    const req = pageLoad('/__session?intent=signin&net=previewnet', 'localhost');

    // When the fallback decides
    const action = fallbackFor(req, PAGES, publicDir().isPublicFile, routeFor);

    // Then it rewrites to the session page with the query
    expect(action).toEqual({ kind: 'rewrite', url: '/session?intent=signin&net=previewnet' });
  });

  it('As a user on local.host, I open /__session on the bare local.host and get the session page', () => {
    // Given a server for both local roots and a page load of the sign-in window on the bare local.host
    const { routeFor } = createLocalServing(ROOTS);
    const req = pageLoad('/__session?intent=signin', 'local.host');

    // When the fallback decides
    const action = fallbackFor(req, PAGES, publicDir().isPublicFile, routeFor);

    // Then it rewrites to the session page
    expect(action).toEqual({ kind: 'rewrite', url: '/session?intent=signin' });
  });

  it('As a visitor on local.host, I open a product subdomain of it and get the shell, not the landing page', () => {
    // Given a server for both local roots and a page load of a product subdomain of local.host
    const { routeFor } = createLocalServing(ROOTS);
    const req = pageLoad('/', 'browse.local.host');

    // When the fallback decides
    const action = fallbackFor(req, PAGES, publicDir().isPublicFile, routeFor);

    // Then it passes the request on to the shell
    expect(action).toEqual({ kind: 'pass' });
  });

  it('As a visitor, I follow /__session on a product host and get the shell, as only the bare host has it', () => {
    // Given a server for both local roots and a page load of the sign-in window path on a product host
    const { routeFor } = createLocalServing(ROOTS);
    const req = pageLoad('/__session?intent=signin');

    // When the fallback decides
    const action = fallbackFor(req, PAGES, publicDir().isPublicFile, routeFor);

    // Then it rewrites to the shell with the query
    expect(action).toEqual({ kind: 'rewrite', url: '/?intent=signin' });
  });
});
