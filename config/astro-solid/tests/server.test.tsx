// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The server renderer (src/server.ts), called the way Astro calls it: bound
// to a page render's result, once per component on the page.

import type { SSRResult } from 'astro';
import type { JSX } from '@solidjs/web';
import { describe, expect, it } from 'vitest';
import renderer from '../src/server.js';

type Props = Record<string, unknown>;
type Metadata = Parameters<typeof renderer.renderToStaticMarkup>[3];

const ISLAND = { astroStaticSlot: true, hydrate: 'load', displayName: 'Island' } as unknown as Metadata;
const STATIC = { astroStaticSlot: true, displayName: 'Static' } as unknown as Metadata;

/** One page render: the components rendered with it share its island ids. */
function page(): { result: SSRResult } {
  return { result: {} as SSRResult };
}

function Greeting(props: { name?: string; children?: JSX.Element; footer?: JSX.Element }): JSX.Element {
  return (
    <section>
      <h1>Hello {props.name}</h1>
      {props.children}
      {props.footer}
    </section>
  );
}

function Broken(): JSX.Element {
  throw new Error('broken component');
}

async function render(
  ctx: { result: SSRResult },
  Component: (props: Props) => JSX.Element,
  props: Props,
  slots: Record<string, string>,
  metadata: Metadata,
): Promise<{ html: string; attrs?: Record<string, string> }> {
  return renderer.renderToStaticMarkup.call(ctx, Component, props, slots, metadata);
}

describe('Solid server renderer', () => {
  it('As a static component, it renders plain HTML without hydration markers or scripts', async () => {
    // When
    const { html, attrs } = await render(page(), Greeting, { name: 'Ada' }, {}, STATIC);

    // Then: the hydratable compile's text markers stay, as inert comments.
    expect(html.replace(/<!--.*?-->/g, '')).toBe('<section><h1>Hello Ada</h1></section>');
    expect(html).not.toContain('_hk=');
    expect(html).not.toContain('<script');
    expect(attrs).toEqual({ 'data-solid-render-id': '' });
  });

  it('As an island, it renders with hydration keys under a render id unique on the page', async () => {
    // Given
    const ctx = page();

    // When
    const first = await render(ctx, Greeting, { name: 'Ada' }, {}, ISLAND);
    const second = await render(ctx, Greeting, { name: 'Bob' }, {}, ISLAND);
    const otherPage = await render(page(), Greeting, {}, {}, ISLAND);

    // Then
    expect(first.attrs).toEqual({ 'data-solid-render-id': 's0' });
    expect(second.attrs).toEqual({ 'data-solid-render-id': 's1' });
    expect(otherPage.attrs).toEqual({ 'data-solid-render-id': 's0' });
    expect(first.html).toMatch(/^<section _hk=s0\d*><h1>Hello <!--\$-->Ada/);
    expect(second.html).toMatch(/_hk=s1/);
  });

  it('As an island, its children and named slots arrive as astro-slot markup, with slot names camel-cased', async () => {
    // When
    const { html } = await render(page(), Greeting, {}, { default: '<p>body</p>', footer: '<em>end</em>' }, ISLAND);

    // Then
    expect(html).toContain('<astro-slot><p>body</p></astro-slot>');
    expect(html).toContain('<astro-slot name="footer"><em>end</em></astro-slot>');
  });

  it('As a static component, its slots arrive as astro-static-slot markup, which Astro strips', async () => {
    // When
    const { html } = await render(page(), Greeting, {}, { default: '<p>body</p>' }, STATIC);

    // Then
    expect(html).toContain('<astro-static-slot><p>body</p></astro-static-slot>');
  });

  it('As a component that throws, the render rejects with its error so Astro can report it', async () => {
    // When / Then
    await expect(render(page(), Broken, {}, {}, STATIC)).rejects.toThrow('broken component');
  });

  it('As Astro picking a renderer, check accepts Solid components and rejects anything else', async () => {
    // Given
    const ctx = page();
    const vnode = (): unknown => ({ $$typeof: Symbol.for('react.element') });
    const svelte = function Svelte($$renderer: unknown): unknown {
      return $$renderer;
    };

    // When / Then
    expect(await renderer.check.call(ctx, Greeting, {}, {})).toBe(true);
    expect(await renderer.check.call(ctx, 'div', {}, {})).toBe(false);
    expect(await renderer.check.call(ctx, vnode, {}, {})).toBe(false);
    expect(await renderer.check.call(ctx, svelte, {}, {})).toBe(false);
    expect(await renderer.check.call(ctx, Broken, {}, {})).toBe(false);
  });

  it('As the first Solid island on a page, the hydration script Astro injects bootstraps Solid', () => {
    // When
    const script = renderer.renderHydrationScript?.() ?? '';

    // Then
    expect(script).toMatch(/^<script[^>]*>.*_\$HY/s);
  });
});
