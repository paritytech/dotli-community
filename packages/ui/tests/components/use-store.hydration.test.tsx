// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// useStore in a hydrating island: the host page's islands are server-rendered
// at build time, from the stores' initial values, and hydrate once the
// browser is idle, by when boot has written the stores. The markup comes
// from @dotli/astro-solid's server entry in a Vite SSR server, with the
// hydratable compile the host builds with; the island hydrates through its
// client entry, as Astro's <astro-island> calls it.

import { resolve } from 'node:path';
import { flush } from 'solid-js';
import solid from '@solidjs/vite-plugin';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import client from '@dotli/astro-solid/client.js';
import { labelStore, StoreLabel } from '../fixtures/store-label.js';

/** What the test calls of @dotli/astro-solid's server entry. */
interface ServerRenderer {
  renderToStaticMarkup: (
    this: { result: unknown },
    component: unknown,
    props: Record<string, unknown>,
    slots: Record<string, unknown>,
    metadata: Record<string, unknown>,
  ) => Promise<{ html: string; attrs?: Record<string, string> }>;
  renderHydrationScript?: () => string;
}

const ROOT = resolve(import.meta.dirname, '../..');

let server: ViteDevServer;
let renderer: ServerRenderer;

beforeAll(async () => {
  // A middleware-mode-only Vite server, never listening on a port.
  server = await createServer({
    configFile: false,
    root: ROOT,
    logLevel: 'warn',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    plugins: [solid({ ssr: true, solid: { hydratable: true } })],
  });
  const mod = (await server.ssrLoadModule('@dotli/astro-solid/server.js')) as { default: ServerRenderer };
  renderer = mod.default;
  // Solid's hydration bootstrap, which Astro puts before the first island.
  const script = /<script[^>]*>(.*)<\/script>/s.exec(renderer.renderHydrationScript?.() ?? '')?.[1] ?? '';
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- runs Solid's own bootstrap script, as the page would.
  (new Function(script) as () => void)();
});

afterAll(async () => {
  await server.close();
});

/** The label, rendered at build time (the server's own store: initial), in an island element. */
async function buildTimeIsland(): Promise<HTMLElement> {
  const fixture = (await server.ssrLoadModule(resolve(ROOT, 'tests/fixtures/store-label.tsx'))) as {
    StoreLabel: unknown;
  };
  const { html, attrs } = await renderer.renderToStaticMarkup.call(
    { result: {} },
    fixture.StoreLabel,
    {},
    {},
    {
      astroStaticSlot: true,
      hydrate: 'idle',
      displayName: 'StoreLabel',
    },
  );
  const element = document.createElement('astro-island');
  element.setAttribute('ssr', '');
  element.dataset['solidRenderId'] = attrs?.['data-solid-render-id'] ?? '';
  element.innerHTML = html;
  document.body.append(element);
  return element;
}

describe('useStore in a hydrating island', () => {
  it('As a visitor, an island that hydrates after boot wrote its store shows the store as it is now', async () => {
    // Given: the build rendered the initial value, and boot has written the
    // store since.
    const element = await buildTimeIsland();
    const serverText = element.querySelector('.text');
    expect(serverText?.textContent).toBe('build');
    labelStore.set({ text: 'live', marked: true });

    // When
    client(element)(StoreLabel, {}, {}, { client: 'idle' });
    flush();

    // Then: the build's markup is the live one, updated.
    const label = element.querySelector('.store-label');
    expect(element.querySelector('.text')).toBe(serverText);
    expect(serverText?.textContent).toBe('live');
    expect(label?.hasAttribute('data-marked')).toBe(true);
    expect(element.querySelector('.mark')?.textContent).toBe('marked');

    // When: the store changes again.
    labelStore.set({ text: 'later', marked: false });
    flush();

    // Then
    expect(serverText?.textContent).toBe('later');
    expect(element.querySelector('.mark')).toBeNull();
  });
});
