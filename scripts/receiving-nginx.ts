// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ReceivingOriginConfig } from '@dotli/config/receiving';

/** Only exact configured Host headers can receive a relay policy or proxy. */
export function renderReceivingNginx(
  entries: readonly ReceivingOriginConfig[],
  site?: string,
): { csp: string; proxy: string } {
  if (site !== undefined) {
    for (const entry of entries) {
      const url = new URL(entry.origin);
      const label = url.hostname.slice(0, -(site.length + 1));
      if (
        url.port ||
        url.hostname !== `${label}.${site}` ||
        !/^[a-z0-9-]+$/.test(label) ||
        ['host', 'app'].includes(label)
      ) {
        throw new Error(`Receiving origin ${entry.origin} is not a product host of ${site}`);
      }
    }
  }
  const policy = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'";
  const csp = [
    `set $dotli_receiving_csp "${policy}";`,
    ...entries.map(
      entry =>
        `if ($http_host = "${new URL(entry.origin).host}") { set $dotli_receiving_csp "${policy} ${new URL(entry.relayUrl).origin}"; }`,
    ),
    'add_header Content-Security-Policy $dotli_receiving_csp always;',
    '',
  ].join('\n');
  const proxy = [
    'location ^~ /__receiving/ {',
    '    set $dotli_receiving_upstream "";',
    ...entries
      .filter(entry => entry.proxyPort !== undefined)
      .map(
        entry =>
          `    if ($http_host = "${new URL(entry.origin).host}") { set $dotli_receiving_upstream "127.0.0.1:${String(entry.proxyPort)}"; }`,
      ),
    '    if ($dotli_receiving_upstream = "") { return 404; }',
    '    client_max_body_size 2m;',
    '    client_body_timeout 10s;',
    '    # Device paths must not enter access logs; relay owns CORS.',
    '    access_log off;',
    '    add_header X-Content-Type-Options nosniff always;',
    '    rewrite ^/__receiving/(.*)$ /$1 break;',
    '    proxy_pass http://$dotli_receiving_upstream;',
    '    proxy_set_header Host $host;',
    '    proxy_set_header X-Forwarded-For $remote_addr;',
    '    proxy_set_header X-Forwarded-Proto https;',
    '    proxy_http_version 1.1;',
    '    proxy_connect_timeout 5s;',
    '    proxy_read_timeout 15s;',
    '    proxy_send_timeout 15s;',
    '    proxy_redirect off;',
    '}',
    '',
  ].join('\n');
  return { csp, proxy };
}
