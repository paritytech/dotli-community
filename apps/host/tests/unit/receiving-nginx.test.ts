// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { parseReceivingOrigins } from '@dotli/config/receiving';
import { renderReceivingNginx } from '../../../../scripts/receiving-nginx.js';

const entries = parseReceivingOrigins(
  JSON.stringify([
    {
      origin: 'https://t3ams-push-test.paseo.fyi',
      relayUrl: 'https://t3ams-push-test.paseo.fyi/__receiving',
      vapidPublicKey: `B${'A'.repeat(86)}`,
      proxyPort: 8789,
    },
    {
      origin: 'https://echat-new.paseo.fyi',
      relayUrl: 'https://echat-relay.example/receiving',
      vapidPublicKey: `B${'B'.repeat(85)}A`,
    },
  ]),
);

describe('receiving nginx deployment output', () => {
  it('selects one relay policy per exact Host and creates no proxy for external relays', () => {
    const { csp, proxy } = renderReceivingNginx(entries, 'paseo.fyi');
    const policy = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'";
    expect(csp.split('\n')).toEqual([
      `set $dotli_receiving_csp "${policy}";`,
      `if ($http_host = "t3ams-push-test.paseo.fyi") { set $dotli_receiving_csp "${policy} https://t3ams-push-test.paseo.fyi"; }`,
      `if ($http_host = "echat-new.paseo.fyi") { set $dotli_receiving_csp "${policy} https://echat-relay.example"; }`,
      'add_header Content-Security-Policy $dotli_receiving_csp always;',
      '',
    ]);
    expect(proxy).toContain(
      'if ($http_host = "t3ams-push-test.paseo.fyi") { set $dotli_receiving_upstream "127.0.0.1:8789"; }',
    );
    expect(proxy).not.toContain('echat-new.paseo.fyi');
    expect(proxy).toContain('if ($dotli_receiving_upstream = "") { return 404; }');
    expect(proxy).toContain('rewrite ^/__receiving/(.*)$ /$1 break;');
    expect(proxy).toContain('proxy_pass http://$dotli_receiving_upstream;');
    expect(proxy).toContain('access_log off;');
    expect(proxy).not.toContain('Access-Control-Allow-Origin');
  });

  it('routes two product hosts to separate loopback ports without normalized Host matching', () => {
    const local = parseReceivingOrigins(
      JSON.stringify(
        entries.map((entry, index) => ({
          ...entry,
          relayUrl: `${entry.origin}/__receiving`,
          proxyPort: 8789 + index,
        })),
      ),
    );
    const { proxy } = renderReceivingNginx(local, 'paseo.fyi');
    expect(proxy.match(/if \(\$http_host = "[^"]+"\) \{ set \$dotli_receiving_upstream "[^"]+"; \}/g)).toEqual([
      'if ($http_host = "t3ams-push-test.paseo.fyi") { set $dotli_receiving_upstream "127.0.0.1:8789"; }',
      'if ($http_host = "echat-new.paseo.fyi") { set $dotli_receiving_upstream "127.0.0.1:8790"; }',
    ]);
    expect(proxy).not.toContain('if ($host');
  });

  it('removes all relay access when the manifest is empty', () => {
    const { csp, proxy } = renderReceivingNginx([], 'paseo.fyi');
    expect(csp).not.toContain('https://');
    expect(csp).not.toContain('if (');
    expect(proxy).not.toContain('127.0.0.1:');
    expect(proxy).toContain('set $dotli_receiving_upstream "";');
    expect(proxy).toContain('if ($dotli_receiving_upstream = "") { return 404; }');
  });

  it.each([
    'https://other.example',
    'https://paseo.fyi',
    'https://host.paseo.fyi',
    'https://app.paseo.fyi',
    'https://cid.app.paseo.fyi',
    'https://echat-new.paseo.fyi:8443',
  ])('refuses deploying an origin outside the product server: %s', origin => {
    const first = entries[0];
    if (!first) {
      throw new Error('Missing fixture');
    }
    expect(() => renderReceivingNginx([{ ...first, origin }], 'paseo.fyi')).toThrow('not a product host');
  });
});
