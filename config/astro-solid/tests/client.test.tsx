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

type ServerRenderer = typeof serverEntry;
type Metadata = NonNullable<Parameters<ServerRenderer['renderToStaticMarkup']>[3]>;

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
  const renderer = await loadServerRenderer();
  const script = /<script[^>]*>(.*)<\/script>/s.exec(renderer.renderHydrationScript?.() ?? '')?.[1] ?? '';
  // The Function constructor types its result as the untyped `Function`.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- runs Solid's own bootstrap script, as the page would.
  (new Function(script) as () => void)();
});

afterAll(async () => {
  await server.close();
});

afterEach(() => {
  document.body.replaceChildren();
});

async function loadServerRenderer(): Promise<ServerRenderer> {
  // Vite types every SSR-loaded module as a plain record.
  const serverModule = (await server.ssrLoadModule(resolve(ROOT, 'src/server.ts'))) as { default: ServerRenderer };
  return serverModule.default;
}

/** Server-renders `name` from the fixtures as a `client:load` island, in an island element. */
async function renderIsland(name: 'Counter' | 'Label', props: Record<string, unknown>): Promise<HTMLElement> {
  const renderer = await loadServerRenderer();
  const fixtures: Record<string, unknown> = await server.ssrLoadModule(resolve(ROOT, 'tests/fixtures/components.tsx'));
  const metadata: Metadata = { astroStaticSlot: true, hydrate: 'load', displayName: name };
  const { html, attrs } = await renderer.renderToStaticMarkup.call(
    // A fresh object stands for one page render: the renderer only keys its page state by it.
    { result: {} },
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

function getButton(element: HTMLElement): HTMLButtonElement {
  const button = element.querySelector('button');
  if (button === null) {
    throw new Error('no button in the island');
  }
  return button;
}

function click(target: Element): void {
  target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  flush();
}

describe('Solid client entrypoint', () => {
  it('As a visitor, I open a client:load island and it hydrates the server markup in place and reacts to my click', async () => {
    // Given
    const element = await renderIsland('Counter', { start: 1 });
    const serverButton = getButton(element);

    // When
    client(element)(Counter, { start: 1 }, {}, { client: 'load' });
    flush();

    // Then: the server's button is the live one.
    expect(getButton(element)).toBe(serverButton);
    expect(element.querySelectorAll('button')).toHaveLength(1);

    // When: the visitor clicks it.
    click(serverButton);

    // Then
    expect(serverButton.textContent).toBe('2');
  });

  it('As a visitor, I click a hydrated island after astro:unmount and it no longer reacts', async () => {
    // Given
    const element = await renderIsland('Counter', { start: 1 });
    client(element)(Counter, { start: 1 }, {}, { client: 'load' });
    flush();
    const live = getButton(element);

    // When
    element.dispatchEvent(new Event('astro:unmount'));
    click(live);

    // Then
    expect(live.textContent).toBe('1');
  });

  it('As a visitor, I open a client:only island and a client render replaces the fallback and takes new props in place', () => {
    // Given
    const element = document.createElement('astro-island');
    element.setAttribute('ssr', '');
    element.innerHTML = '<p>fallback</p>';
    document.body.append(element);

    // When
    client(element)(Label, { text: 'one' }, {}, { client: 'only' });
    flush();
    const label = element.querySelector('[data-testid="label"]');

    // Then
    expect(element.innerHTML).toBe('<span data-testid="label">one</span>');

    // When: Astro renders the island again with new props.
    client(element)(Label, { text: 'two' }, {}, { client: 'only' });
    flush();

    // Then
    expect(element.querySelector('[data-testid="label"]')).toBe(label);
    expect(label?.textContent).toBe('two');
  });

  it('As a visitor, I open an island whose server render Astro skipped and it keeps the fallback until the render arrives', () => {
    // Given
    const element = document.createElement('astro-island');
    element.innerHTML = '<p>fallback</p>';

    // When
    client(element)(Label, { text: 'one' }, {}, { client: 'load' });

    // Then
    expect(element.innerHTML).toBe('<p>fallback</p>');
  });
});
