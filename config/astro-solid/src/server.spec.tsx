// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Called the way Astro calls it: bound to a page render's result, once per component on the page.

import type { JSX } from '@solidjs/web';
import { describe, expect, it } from 'vitest';
import renderer from './server.js';

type Props = Record<string, unknown>;
type Metadata = NonNullable<Parameters<typeof renderer.renderToStaticMarkup>[3]>;

/** One page render: the components rendered with it share its island ids. */
type Page = {
  /** Astro's render result, which the renderer keys its page state by. */
  result: object;
};

type Params = {
  /** The page render the component belongs to. Defaults to a fresh page. */
  page?: Page;
  /** The component to render. */
  Component: (props: Props) => JSX.Element;
  /** Its props. Defaults to none. */
  props?: Props;
  /** Its slots' HTML by slot name. Defaults to none. */
  slots?: Record<string, string>;
  /** How Astro renders it: as an island or as a static component. */
  metadata: Metadata;
};

const ISLAND: Metadata = { astroStaticSlot: true, hydrate: 'load', displayName: 'Island' };
const STATIC: Metadata = { astroStaticSlot: true, displayName: 'Static' };

/** Returns a fresh page render, which the renderer keys its page state by. */
function createPage(): Page {
  return { result: {} };
}

/** Renders `Component` the way Astro does. Rejects with the component's error. */
async function render({
  page = createPage(),
  Component,
  props = {},
  slots = {},
  metadata,
}: Params): Promise<{ html: string; attrs?: Record<string, string> }> {
  return renderer.renderToStaticMarkup.call(page, Component, props, slots, metadata);
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

function Foreign(): JSX.Element {
  // Another framework's element is no Solid element, which is the case under test.
  return { $$typeof: Symbol.for('react.element') } as unknown as JSX.Element;
}

describe('Solid server renderer', () => {
  it('As a dotli developer, I render a static component and get plain HTML without hydration markers or scripts', async () => {
    // Given a static component's props
    const props = { name: 'Ada' };

    // When
    const { html, attrs } = await render({ Component: Greeting, props, metadata: STATIC });

    // Then: the hydratable compile's text markers stay, as inert comments.
    expect(html.replace(/<!--.*?-->/g, '')).toBe('<section><h1>Hello Ada</h1></section>');
    expect(html).not.toContain('_hk=');
    expect(html).not.toContain('<script');
    expect(attrs).toEqual({ 'data-solid-render-id': '' });
  });

  it('As a dotli developer, I render islands on a page and each gets hydration keys under a render id unique on the page', async () => {
    // Given
    const page = createPage();

    // When
    const first = await render({ page, Component: Greeting, props: { name: 'Ada' }, metadata: ISLAND });
    const second = await render({ page, Component: Greeting, props: { name: 'Bob' }, metadata: ISLAND });
    const otherPage = await render({ Component: Greeting, metadata: ISLAND });

    // Then
    expect(first.attrs).toEqual({ 'data-solid-render-id': 's0' });
    expect(second.attrs).toEqual({ 'data-solid-render-id': 's1' });
    expect(otherPage.attrs).toEqual({ 'data-solid-render-id': 's0' });
    expect(first.html).toMatch(/^<section _hk=s0\d*><h1>Hello <!--\$-->Ada/);
    expect(second.html).toMatch(/_hk=s1/);
  });

  it('As a dotli developer, I pass children and named slots to an island and they arrive as astro-slot markup with camel-cased slot names', async () => {
    // Given an island's default and named slots
    const slots = { default: '<p>body</p>', footer: '<em>end</em>' };

    // When
    const { html } = await render({ Component: Greeting, slots, metadata: ISLAND });

    // Then
    expect(html).toContain('<astro-slot><p>body</p></astro-slot>');
    expect(html).toContain('<astro-slot name="footer"><em>end</em></astro-slot>');
  });

  it('As a dotli developer, I pass slots to a static component and they arrive as astro-static-slot markup, which Astro strips', async () => {
    // Given a static component's default slot
    const slots = { default: '<p>body</p>' };

    // When
    const { html } = await render({ Component: Greeting, slots, metadata: STATIC });

    // Then
    expect(html).toContain('<astro-static-slot><p>body</p></astro-static-slot>');
  });

  it('As a dotli developer, I render a component that throws and the render rejects with its error so Astro can report it', async () => {
    // Given a component that throws while it renders

    // When
    const rendering = render({ Component: Broken, metadata: STATIC });

    // Then
    await expect(rendering).rejects.toThrow('broken component');
  });

  it('As a dotli developer, I render a component that returns a foreign framework vnode and the render rejects naming it as not a Solid component', async () => {
    // Given a component that returns another framework's element

    // When
    const rendering = render({ Component: Foreign, metadata: STATIC });

    // Then
    await expect(rendering).rejects.toThrow('Foreign is not a Solid component');
  });

  it('As an Astro page picking a renderer, I ask Solid to check each component and it accepts only Solid components', async () => {
    // Given
    const page = createPage();
    const vnode = (): unknown => ({ $$typeof: Symbol.for('react.element') });
    const svelte = function Svelte($$renderer: unknown): unknown {
      return $$renderer;
    };

    // When each is checked in turn, as Astro does
    const verdicts: boolean[] = [];
    for (const Component of [Greeting, 'div', vnode, svelte, Broken]) {
      verdicts.push(await renderer.check.call(page, Component, {}, {}));
    }

    // Then
    expect(verdicts).toEqual([true, false, false, false, false]);
  });
});
