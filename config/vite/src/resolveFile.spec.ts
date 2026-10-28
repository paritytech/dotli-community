// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveFile } from './resolveFile.js';
import type { Route } from './siteRoutes.js';

const DIR = '/srv/host';

/** The bare host's route, which `localhost` reaches. */
const BARE_HOST: Route = { site: 'host', bare: true };

/** A product host's route, which `browse.localhost` reaches. */
const PRODUCT_HOST: Route = { site: 'host', bare: false };

/** A build folder holding `paths`, which records every path a lookup asks for. */
function createBuildFolder(...paths: string[]): { asked: string[]; isFile: (path: string) => boolean } {
  const present = new Set(paths.map(path => join(DIR, path)));
  const asked: string[] = [];

  function isFile(path: string): boolean {
    asked.push(path);
    return present.has(path);
  }

  return { asked, isFile };
}

describe('resolveFile', () => {
  it('As a visitor, I open the bare host and get the landing page', () => {
    // Given a build with the landing page and the shell
    const disk = createBuildFolder('landing.html', 'index.html');

    // When
    const resolved = resolveFile({ dir: DIR, route: BARE_HOST, pathname: '/', isFile: disk.isFile });

    // Then
    expect(resolved).toEqual({ file: join(DIR, 'landing.html'), pathname: '/landing.html' });
  });

  it('As a visitor, I follow a deep link on a product host and get the shell', () => {
    // Given a build with the shell
    const disk = createBuildFolder('index.html');

    // When
    const resolved = resolveFile({ dir: DIR, route: PRODUCT_HOST, pathname: '/some/page', isFile: disk.isFile });

    // Then
    expect(resolved).toEqual({ file: join(DIR, 'index.html'), pathname: '/index.html' });
  });

  it('As a page, I load an asset that exists and get the file under its own path', () => {
    // Given a build with the shell and an asset
    const disk = createBuildFolder('index.html', 'assets/index-A.js');

    // When
    const resolved = resolveFile({
      dir: DIR,
      route: PRODUCT_HOST,
      pathname: '/assets/index-A.js',
      isFile: disk.isFile,
    });

    // Then
    expect(resolved).toEqual({ file: join(DIR, 'assets/index-A.js'), pathname: '/assets/index-A.js' });
  });

  it('As a page after a deploy, I ask for an asset, a worker or the version file that is gone and get a 404, not the shell', () => {
    // Given a build with only the shell
    const disk = createBuildFolder('index.html');

    // When
    const answers = ['/assets/gone.js', '/host-sw.js', '/host_version.json'].map(pathname =>
      resolveFile({ dir: DIR, route: PRODUCT_HOST, pathname, isFile: disk.isFile }),
    );

    // Then
    expect(answers).toEqual([undefined, undefined, undefined]);
  });

  it('As an attacker, I ask for a path that climbs out of the build and am answered from inside it', () => {
    // Given a build with only the shell
    const disk = createBuildFolder('index.html');

    // When
    const answers = ['/..%2f..%2f..%2fetc%2fpasswd', '/%2e%2e/%2e%2e/etc/passwd', '/a%00b', '..', '../x'].map(
      pathname => resolveFile({ dir: DIR, route: PRODUCT_HOST, pathname, isFile: disk.isFile }),
    );

    // Then
    expect(answers.every(answer => answer?.file === join(DIR, 'index.html'))).toBe(true);
    expect(disk.asked.every(path => path.startsWith(`${DIR}${sep}`))).toBe(true);
  });

  it('As a visitor, I send a malformed escape and get a 404', () => {
    // Given a build with the shell
    const disk = createBuildFolder('index.html');

    // When
    const resolved = resolveFile({ dir: DIR, route: PRODUCT_HOST, pathname: '/%E0%A4%A', isFile: disk.isFile });

    // Then
    expect(resolved).toBeUndefined();
  });

  it('As a visitor, I open a folder on the bare host and get its index', () => {
    // Given a build with a folder index
    const disk = createBuildFolder('landing.html', 'index.html', 'docs/index.html');

    // When the folder is resolved on the bare host
    const resolved = resolveFile({ dir: DIR, route: BARE_HOST, pathname: '/docs/', isFile: disk.isFile });

    // Then the folder's index answers
    expect(resolved).toEqual({ file: join(DIR, 'docs/index.html'), pathname: '/docs/' });
  });

  it('As a user, I open /s/auth, /s/signout, /s/manage and /s/sign on the bare host and get the session window', () => {
    // Given a build with the session window
    const disk = createBuildFolder('landing.html', 'index.html', 'session.html');

    // When each session path is resolved on the bare host
    const resolved = ['/s/auth', '/s/signout', '/s/manage', '/s/sign'].map(pathname =>
      resolveFile({ dir: DIR, route: BARE_HOST, pathname, isFile: disk.isFile }),
    );

    // Then the session window is served for each
    expect(resolved).toEqual([
      { file: join(DIR, 'session.html'), pathname: '/s/auth' },
      { file: join(DIR, 'session.html'), pathname: '/s/signout' },
      { file: join(DIR, 'session.html'), pathname: '/s/manage' },
      { file: join(DIR, 'session.html'), pathname: '/s/sign' },
    ]);
  });

  it('As a visitor, I open a path near the session windows on the bare host and get the shell, not the session window', () => {
    // Given a build with the session window
    const disk = createBuildFolder('landing.html', 'index.html', 'session.html');

    // When a trailing slash, another session segment path and the old path are resolved on the bare host
    const resolved = ['/s/auth/', '/s/other', '/__session'].map(
      pathname => resolveFile({ dir: DIR, route: BARE_HOST, pathname, isFile: disk.isFile })?.file,
    );

    // Then the shell answers each of them
    expect(resolved).toEqual([join(DIR, 'index.html'), join(DIR, 'index.html'), join(DIR, 'index.html')]);
  });

  it('As a visitor, I send a malformed escape under the session segment on the bare host and get a 404, not the session window', () => {
    // Given a build with the session window
    const disk = createBuildFolder('landing.html', 'index.html', 'session.html');

    // When the malformed path is resolved on the bare host
    const resolved = resolveFile({ dir: DIR, route: BARE_HOST, pathname: '/s/%E0%A4%A', isFile: disk.isFile });

    // Then no file is served
    expect(resolved).toBeUndefined();
  });

  it.each([
    ['/s/%61uth', '/s/auth'],
    ['/s/%6Danage', '/s/manage'],
    ['/s/%73ign', '/s/sign'],
  ])(
    'As a user, I open the percent-encoded session path %s on the bare host and get the session window',
    (pathname, decoded) => {
      // Given a build with the session window
      const disk = createBuildFolder('landing.html', 'index.html', 'session.html');

      // When the encoded session path is resolved on the bare host
      const resolved = resolveFile({ dir: DIR, route: BARE_HOST, pathname, isFile: disk.isFile });

      // Then the session window is served
      expect(resolved).toEqual({ file: join(DIR, 'session.html'), pathname: decoded });
    },
  );

  it('As a user on a build without the session window, I open the session window and get a 404, not the shell', () => {
    // Given a build without the session window
    const disk = createBuildFolder('landing.html', 'index.html');

    // When the session path is resolved on the bare host
    const resolved = resolveFile({ dir: DIR, route: BARE_HOST, pathname: '/s/auth', isFile: disk.isFile });

    // Then no file is served
    expect(resolved).toBeUndefined();
  });

  it('As a page framing the session window, I ask for its built file and get a 404 on any host', () => {
    // Given a build with the session window
    const disk = createBuildFolder('landing.html', 'index.html', 'session.html');

    // When the built session file is asked for on each host and spelling
    const answers = [
      { route: BARE_HOST, pathname: '/session.html' },
      { route: PRODUCT_HOST, pathname: '/session.html' },
      { route: BARE_HOST, pathname: '//session.html' },
      { route: BARE_HOST, pathname: '/./session.html' },
      { route: BARE_HOST, pathname: '/%73ession.html' },
    ].map(({ route, pathname }) => resolveFile({ dir: DIR, route, pathname, isFile: disk.isFile }));

    // Then no file is served for any of them
    expect(answers).toEqual([undefined, undefined, undefined, undefined, undefined]);
  });
});
