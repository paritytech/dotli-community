// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LOCAL_SERVER_HEADERS,
  fileHeaders,
  headerPolicy,
  resolveFile,
  responseHeaders,
  rootPage,
  routeFor,
  securityHeaders,
} from './serving.js';

const SNIPPETS = join(import.meta.dirname, '../../../nginx/snippets');
const NGINX_ANCESTORS = '$csp_ancestors';

/**
 * The headers a snippet adds, following its includes, as nginx sends them. An `add_header` it cannot read fails the
 * spec, so a value written another way cannot drift unseen.
 */
function nginxHeaders(snippet: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of readFileSync(join(SNIPPETS, snippet), 'utf8').split('\n')) {
    const include = /^\s*include \/etc\/nginx\/snippets\/(\S+);/.exec(line);
    if (include?.[1] !== undefined) {
      Object.assign(headers, nginxHeaders(include[1]));
    }
    if (!/^\s*add_header\b/.test(line)) {
      continue;
    }
    const header = /^\s*add_header (\S+) "([^"]*)"( always)?;\s*$/.exec(line);
    if (header?.[1] === undefined || header[2] === undefined) {
      throw new Error(`${snippet}: cannot read "${line.trim()}"`);
    }
    headers[header[1]] = header[2];
  }
  return headers;
}

describe('routeFor', () => {
  it('As a visitor, I open the bare host and get the host build with the landing page at its root', () => {
    // Given
    const hostname = 'localhost';

    // When
    const route = routeFor(hostname);

    // Then
    expect(route).toEqual({ site: 'host', bare: true });
    expect(rootPage(route)).toBe('landing.html');
  });

  it('As a visitor, I open a product subdomain and get the shell', () => {
    // Given
    const hostname = 'browse.localhost';

    // When
    const route = routeFor(hostname);

    // Then
    expect(route).toEqual({ site: 'host', bare: false });
    expect(rootPage(route)).toBe('index.html');
  });

  it('As a product, I load my sandbox origin and the protocol origin and each reaches its own build', () => {
    // Given
    const sandbox = 'myapp.app.localhost';
    const protocol = 'host.localhost';

    // When
    const routes = [routeFor(sandbox), routeFor(protocol)];

    // Then
    expect(routes.map(route => route.site)).toEqual(['app', 'protocol']);
  });
});

describe('headerPolicy', () => {
  it('As a sandbox page, I am served from my origin and every response is isolated', () => {
    // Given
    const sandbox = routeFor('myapp.app.localhost');
    const protocol = routeFor('host.localhost');

    // When
    const policies = [headerPolicy(sandbox, '/'), headerPolicy(protocol, '/assets/a.js')];

    // Then
    expect(policies).toEqual(['isolated', 'isolated']);
  });

  it("As a preview embedder, I open /__preview and only the bare host's page is isolated", () => {
    // Given
    const bare = routeFor('localhost');
    const shell = routeFor('browse.localhost');

    // When
    const policies = [headerPolicy(bare, '/__preview'), headerPolicy(shell, '/__preview')];

    // Then
    expect(policies).toEqual(['isolated', 'plain']);
  });

  it('As a product host, my assets carry no COEP', () => {
    // Given
    const shell = routeFor('browse.localhost');

    // When
    const policy = headerPolicy(shell, '/assets/w.js');

    // Then
    expect(policy).toBe('plain');
  });

  it('As the bare host, my assets carry COEP so /__preview can start their workers', () => {
    // Given
    const bare = routeFor('localhost');

    // When
    const policy = headerPolicy(bare, '/assets/w.js');

    // Then
    expect(policy).toBe('worker-coep');
  });
});

describe('responseHeaders', () => {
  it('As the release server, I send a precompressed asset with the type of the file it stands for', () => {
    // Given
    const pathname = '/assets/a.js';

    // When
    const headers = responseHeaders('/dist/host/assets/a.js', pathname, 'worker-coep');

    // Then
    expect(headers).toEqual({
      'Content-Type': 'text/javascript',
      ...fileHeaders(pathname),
      ...securityHeaders('worker-coep'),
      ...LOCAL_SERVER_HEADERS,
    });
  });

  it('As the test server, I send a file of an unknown type as bytes', () => {
    // When
    const headers = responseHeaders('/dist/app/blob.bin', '/blob.bin', 'isolated');

    // Then
    expect(headers['Content-Type']).toBe('application/octet-stream');
  });
});

describe('resolveFile', () => {
  const DIR = '/srv/host';

  /** A build folder holding `paths`, which records every path a lookup asks for. */
  function build(...paths: string[]): { asked: string[]; isFile: (path: string) => boolean } {
    const present = new Set(paths.map(path => join(DIR, path)));
    const asked: string[] = [];
    return {
      asked,
      isFile: path => {
        asked.push(path);
        return present.has(path);
      },
    };
  }

  it('As a visitor, I open the bare host and get the landing page', () => {
    // Given
    const disk = build('landing.html', 'index.html');

    // When
    const resolved = resolveFile(DIR, routeFor('localhost'), '/', disk.isFile);

    // Then
    expect(resolved).toEqual({ file: join(DIR, 'landing.html'), pathname: '/landing.html' });
  });

  it('As a visitor, I follow a deep link on a product host and get the shell', () => {
    // Given
    const disk = build('index.html');

    // When
    const resolved = resolveFile(DIR, routeFor('browse.localhost'), '/some/page', disk.isFile);

    // Then
    expect(resolved).toEqual({ file: join(DIR, 'index.html'), pathname: '/index.html' });
  });

  it('As a page, I load an asset that exists and get the file under its own path', () => {
    // Given
    const disk = build('index.html', 'assets/index-A.js');

    // When
    const resolved = resolveFile(DIR, routeFor('browse.localhost'), '/assets/index-A.js', disk.isFile);

    // Then
    expect(resolved).toEqual({ file: join(DIR, 'assets/index-A.js'), pathname: '/assets/index-A.js' });
  });

  it('As a page after a deploy, I ask for an asset, a worker or the version file that is gone and get a 404, not the shell', () => {
    // Given
    const disk = build('index.html');

    // When
    const answers = ['/assets/gone.js', '/host-sw.js', '/host_version.json'].map(path =>
      resolveFile(DIR, routeFor('browse.localhost'), path, disk.isFile),
    );

    // Then
    expect(answers).toEqual([undefined, undefined, undefined]);
  });

  it('As an attacker, I ask for a path that climbs out of the build and am answered from inside it', () => {
    // Given
    const disk = build('index.html');

    // When
    const answers = ['/..%2f..%2f..%2fetc%2fpasswd', '/%2e%2e/%2e%2e/etc/passwd', '/a%00b', '..', '../x'].map(path =>
      resolveFile(DIR, routeFor('browse.localhost'), path, disk.isFile),
    );

    // Then
    expect(answers.every(answer => answer?.file === join(DIR, 'index.html'))).toBe(true);
    expect(disk.asked.every(path => path.startsWith(`${DIR}${sep}`))).toBe(true);
  });

  it('As a visitor, I send a malformed escape and get a 404', () => {
    // Given
    const disk = build('index.html');

    // When
    const resolved = resolveFile(DIR, routeFor('browse.localhost'), '/%E0%A4%A', disk.isFile);

    // Then
    expect(resolved).toBeUndefined();
  });

  it("As a visitor, I open a folder on the bare host and get its index, as nginx's bare-host block tries it", () => {
    // Given
    const disk = build('landing.html', 'index.html', 'docs/index.html');

    // When
    const resolved = resolveFile(DIR, routeFor('localhost'), '/docs/', disk.isFile);

    // Then
    expect(resolved).toEqual({ file: join(DIR, 'docs/index.html'), pathname: '/docs/' });
  });
});

describe('the table against nginx', () => {
  it('As an operator, I run a Node server and a shell page carries the headers nginx sends', () => {
    // Given
    const nginx = nginxHeaders('dotli-headers-host.conf');

    // When
    const headers = securityHeaders('plain', NGINX_ANCESTORS);

    // Then
    expect(headers).toEqual(nginx);
  });

  it('As an operator, I run a Node server and a sandbox page carries the isolation headers nginx sends', () => {
    // Given
    const nginx = nginxHeaders('dotli-headers-iframeable.conf');

    // When
    const headers = securityHeaders('isolated', NGINX_ANCESTORS);

    // Then
    expect(headers).toEqual(nginx);
  });

  it('As an operator, I run a Node server and host and sandbox assets carry the headers nginx sends', () => {
    // Given
    const nginx = [
      nginxHeaders('dotli-assets-host.conf'),
      nginxHeaders('dotli-assets-preview.conf'),
      nginxHeaders('dotli-assets-iframeable.conf'),
    ];

    // When
    const headers = [
      { ...securityHeaders('plain', NGINX_ANCESTORS), ...fileHeaders('/assets/a.js') },
      { ...securityHeaders('worker-coep', NGINX_ANCESTORS), ...fileHeaders('/assets/a.js') },
      { ...securityHeaders('isolated', NGINX_ANCESTORS), ...fileHeaders('/assets/a.js') },
    ];

    // Then
    expect(headers).toEqual(nginx);
  });

  it('As an operator, I run a Node server and each service worker carries the headers nginx sends', () => {
    // Given
    const nginx = [nginxHeaders('dotli-sw-app.conf'), nginxHeaders('dotli-sw-host.conf')];

    // When
    const headers = [
      { ...securityHeaders('isolated', NGINX_ANCESTORS), ...fileHeaders('/app-sw.js') },
      { ...securityHeaders('plain', NGINX_ANCESTORS), ...fileHeaders('/host-sw.js') },
    ];

    // Then
    expect(headers).toEqual(nginx);
  });
});
