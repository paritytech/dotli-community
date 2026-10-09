// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Called the way Astro's <astro-island> calls it. The server markup comes from the server entrypoint in a Vite SSR
// server with the same Solid compile, as in Astro's build.

import { resolve } from 'node:path';
import { flush } from 'solid-js';
import solid from '@solidjs/vite-plugin';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import client from '../src/client.js';
import type serverEntry from '../src/server.js';
import { Counter, Label } from './fixtures/components.js';

const ROOT = resolve(import.meta.dirname, '..');

let server: ViteDevServer;

beforeAll(async () => {
  server = await createServer({
    configFile: false,
    root: ROOT,
    logLevel: 'warn',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    plugins: [solid({ ssr: true, solid: { hydratable: true } })],
  });
  // Solid's hydration bootstrap, which Astro puts before the first island.
  const renderer = await serverRenderer();
  const script = /<script[^>]*>(.*)<\/script>/s.exec(renderer.renderHydrationScript?.() ?? '')?.[1] ?? '';
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- runs Solid's own bootstrap script, as the page would.
  (new Function(script) as () => void)();
});

afterAll(async () => {
  await server.close();
});

afterEach(() => {
  document.body.replaceChildren();
});

type ServerRenderer = typeof serverEntry;

async function serverRenderer(): Promise<ServerRenderer> {
  const mod = (await server.ssrLoadModule(resolve(ROOT, 'src/server.ts'))) as { default: ServerRenderer };
  return mod.default;
}

/** Server-renders `name` from the fixtures as a `client:load` island, in an island element. */
async function island(name: 'Counter' | 'Label', props: Record<string, unknown>): Promise<HTMLElement> {
  const renderer = await serverRenderer();
  const fixtures = (await server.ssrLoadModule(resolve(ROOT, 'tests/fixtures/components.tsx'))) as Record<
    string,
    unknown
  >;
  const metadata = { astroStaticSlot: true, hydrate: 'load', displayName: name } as unknown as Parameters<
    ServerRenderer['renderToStaticMarkup']
  >[3];
  const { html, attrs } = await renderer.renderToStaticMarkup.call(
    { result: {} as never },
    fixtures[name],
    props,
    {},
    metadata,
  );
  const element = document.createElement('astro-island');
  element.setAttribute('ssr', '');
  element.dataset['solidRenderId'] = attrs?.['data-solid-render-id'] ?? '';
  element.innerHTML = html;
  document.body.append(element);
  return element;
}

function button(element: HTMLElement): HTMLButtonElement {
  const el = element.querySelector('button');
  if (el === null) {
    throw new Error('no button in the island');
  }
  return el;
}

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  flush();
}

describe('Solid client entrypoint', () => {
  it('As a client:load island, it hydrates the server markup in place, and the island reacts', async () => {
    // Given
    const element = await island('Counter', { start: 1 });
    const serverButton = button(element);

    // When
    client(element)(Counter, { start: 1 }, {}, { client: 'load' });
    flush();

    // Then: the server's button is the live one.
    expect(button(element)).toBe(serverButton);
    expect(element.querySelectorAll('button')).toHaveLength(1);
    click(serverButton);
    expect(serverButton.textContent).toBe('2');
  });

  it('As a hydrated island, astro:unmount disposes it', async () => {
    // Given
    const element = await island('Counter', { start: 1 });
    client(element)(Counter, { start: 1 }, {}, { client: 'load' });
    flush();
    const live = button(element);

    // When
    element.dispatchEvent(new Event('astro:unmount'));
    click(live);

    // Then
    expect(live.textContent).toBe('1');
  });

  it('As a client:only island, it replaces the fallback with a client render, and takes new props in place', () => {
    // Given
    const element = document.createElement('astro-island');
    element.setAttribute('ssr', '');
    element.innerHTML = '<p>fallback</p>';
    document.body.append(element);

    // When
    client(element)(Label, { text: 'one' }, {}, { client: 'only' });
    flush();

    // Then
    expect(element.innerHTML).toBe('<span class="label">one</span>');
    const label = element.querySelector('.label');

    // When: Astro renders the island again with new props.
    client(element)(Label, { text: 'two' }, {}, { client: 'only' });
    flush();

    // Then
    expect(element.querySelector('.label')).toBe(label);
    expect(label?.textContent).toBe('two');
  });

  it('As an island whose server render Astro skipped, it waits for the render (no ssr attribute)', () => {
    // Given
    const element = document.createElement('astro-island');
    element.innerHTML = '<p>fallback</p>';

    // When
    client(element)(Label, { text: 'one' }, {}, { client: 'load' });

    // Then
    expect(element.innerHTML).toBe('<p>fallback</p>');
  });
});
