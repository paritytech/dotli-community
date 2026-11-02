// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { getFileHeaders } from './getFileHeaders.js';
import { getPolicyHeaders } from './getPolicyHeaders.js';
import { readNginxHeaders } from './testing/nginx.js';

const NGINX_ANCESTORS = '$csp_ancestors';

describe('the table against nginx', () => {
  it('As an operator, I run a Node server and a shell page carries the headers nginx sends', () => {
    // Given the headers nginx sends with a shell page
    const nginx = readNginxHeaders('nginx/snippets/dotli-headers-host.conf');

    // When
    const headers = getPolicyHeaders('plain', NGINX_ANCESTORS);

    // Then they match nginx
    expect(headers).toEqual(nginx);
  });

  it.each(['/s/auth', '/s/signout', '/s/manage', '/s/sign'])(
    'As an operator, I run a Node server and the session window at %s carries the headers nginx sends',
    location => {
      // Given the headers nginx sends with that location of the session window
      const nginx = readNginxHeaders('nginx/snippets/dotli-session-page.conf', { location });

      // When the Node server's unframed headers are built
      const headers = getPolicyHeaders('unframed', NGINX_ANCESTORS);

      // Then they match nginx
      expect(headers).toEqual(nginx);
    },
  );

  it('As an operator, I run a Node server and a sandbox page carries the isolation headers nginx sends', () => {
    // Given the headers nginx sends with a sandbox page
    const nginx = readNginxHeaders('nginx/snippets/dotli-headers-iframeable.conf');

    // When
    const headers = getPolicyHeaders('isolated', NGINX_ANCESTORS);

    // Then
    expect(headers).toEqual(nginx);
  });

  it('As an operator, I run a Node server and host and sandbox assets carry the headers nginx sends', () => {
    // Given the headers nginx sends with host, preview and sandbox assets
    const nginx = [
      readNginxHeaders('nginx/snippets/dotli-assets-host.conf'),
      readNginxHeaders('nginx/snippets/dotli-assets-preview.conf'),
      readNginxHeaders('nginx/snippets/dotli-assets-iframeable.conf'),
    ];

    // When
    const headers = [
      { ...getPolicyHeaders('plain', NGINX_ANCESTORS), ...getFileHeaders('/assets/a.js') },
      { ...getPolicyHeaders('worker-coep', NGINX_ANCESTORS), ...getFileHeaders('/assets/a.js') },
      { ...getPolicyHeaders('isolated', NGINX_ANCESTORS), ...getFileHeaders('/assets/a.js') },
    ];

    // Then
    expect(headers).toEqual(nginx);
  });

  it('As an operator, I run a Node server and each service worker carries the headers nginx sends', () => {
    // Given the headers nginx sends with each service worker
    const nginx = [
      readNginxHeaders('nginx/snippets/dotli-sw-app.conf'),
      readNginxHeaders('nginx/snippets/dotli-sw-host.conf'),
    ];

    // When
    const headers = [
      { ...getPolicyHeaders('isolated', NGINX_ANCESTORS), ...getFileHeaders('/app-sw.js') },
      { ...getPolicyHeaders('plain', NGINX_ANCESTORS), ...getFileHeaders('/host-sw.js') },
    ];

    // Then
    expect(headers).toEqual(nginx);
  });
});
