// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Astro's server entrypoint for Solid components.

import { createComponent, generateHydrationScript, NoHydration, renderToStream, ssr } from '@solidjs/web';
import type { Component } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { NamedSSRLoadedRendererValue } from 'astro';
import { getPageRenderState, type PageRenderState } from './context.js';
import { PACKAGE_NAME } from './packageName.js';
import type { RendererContext } from './types.js';

type Props = Record<string, unknown>;
type Manifest = NonNullable<NonNullable<Parameters<typeof renderToStream>[1]>['manifest']>;

type Metadata = {
  /** The island's client directive, absent for a static component. */
  hydrate?: string;
  /** Set when Astro strips static slot markup, so a static component's slots render as static slots. */
  astroStaticSlot?: boolean;
  /** `probe` renders only to test the component: no scripts, no head output and no thrown render error. */
  renderStrategy?: 'default' | 'probe';
  /** Called when a probe render reports an error. */
  onProbeError?: () => void;
};

type Params = {
  /** The renderer context Astro checks the component in. */
  context: RendererContext;
  /** The component to probe. */
  Component: Component<Props>;
  /** The props Astro checks it with. */
  props: Props;
  /** The slots' HTML Astro checks it with, by slot name. */
  children: Record<string, string>;
};

// Resolves lazy boundary module URLs. Outside Vite (the Container API) the import fails and rendering goes on without
// asset resolution.
let manifestLoader: (() => unknown) | null | undefined;

// Probe verdicts are stable per component, so the probe's async work runs once per type.
const checkCache = new WeakMap<object, boolean>();

const STYLE_OR_LINK_PATTERN = /<style\b[^>]*>[\s\S]*?<\/style>|<link\b[^>]*>/gi;

/** The Solid renderer Astro loads for server renders. */
const renderer: NamedSSRLoadedRendererValue = {
  name: PACKAGE_NAME,
  check,
  renderToStaticMarkup,
  supportsAstroStaticSlot: true,
  renderHydrationScript: () => generateHydrationScript(),
};

export default renderer;

/** Resolves to whether `Component` renders as a Solid component. Never rejects, and caches the verdict per type. */
async function check(
  this: RendererContext,
  Component: unknown,
  props: Props,
  children: Record<string, string>,
): Promise<boolean> {
  if (typeof Component !== 'function') {
    return false;
  }
  const cached = checkCache.get(Component);
  if (cached !== undefined) {
    return cached;
  }
  // Known only to be a function: the probe render is what tests it as a Solid component.
  const verdict = await probeSolidComponent({
    context: this,
    Component: Component as Component<Props>,
    props,
    children,
  });
  checkCache.set(Component, verdict);
  return verdict;
}

/** Resolves to whether `Component` renders as a Solid component. Never rejects. */
async function probeSolidComponent({ context, Component, props, children }: Params): Promise<boolean> {
  if (Component.name === 'QwikComponent') {
    return false;
  }
  // Solid renders a Svelte component as an empty string, so a Svelte component is told by its compiled source
  // (`$$payload` before Svelte 5, `$$renderer` since). `Component.toString()` would trip Proxy `get` traps.
  let componentSource = '';
  try {
    componentSource = Function.prototype.toString.call(Component);
    // eslint-disable-next-line no-restricted-syntax -- no source to read (a revoked Proxy, an exotic callable): the probe render below decides.
  } catch {
    /* no source to read: the probe render below decides */
  }
  if (componentSource.includes('$$payload') || componentSource.includes('$$renderer')) {
    return false;
  }

  // Solid components are plain functions, so probe-render and reject anything that errors. A stream render, because a
  // sync render of an async component throws and orphans promise rejections.
  let errored = false;
  try {
    const { html } = await renderToStaticMarkup.call(context, Component, props, children, {
      renderStrategy: 'probe',
      onProbeError() {
        errored = true;
      },
    });
    return typeof html === 'string' && !errored;
  } catch {
    // A probe render that throws marks the component as not Solid.
    return false;
  }
}

/**
 * Resolves to the component's HTML, with its island styles first, and its render id attribute.
 *
 * Rejects with the component's error when a real render fails. A probe render reports it through `onProbeError`.
 */
async function renderToStaticMarkup(
  this: RendererContext,
  Component: Component<Props>,
  props: Props,
  { default: children, ...slotted }: Record<string, string>,
  metadata?: Metadata,
): Promise<{ attrs: Record<string, string>; html: string }> {
  const pageRenderState = getPageRenderState(this.result);
  const renderId = metadata?.hydrate !== undefined ? pageRenderState.claimRenderId() : '';
  const needsHydrate = metadata?.astroStaticSlot === true ? metadata.hydrate !== undefined : true;
  const tagName = needsHydrate ? 'astro-slot' : 'astro-static-slot';

  const isProbe = metadata?.renderStrategy === 'probe';

  // The stream never rejects. Uncontained errors surface through onError and are rethrown for real renders, so Astro
  // can report them.
  let renderError: { error: unknown } | undefined;
  let head = '';
  const manifest = await getManifest();
  const componentHtml = await renderToStream(renderWithSlots, {
    renderId,
    noScripts: !needsHydrate || isProbe,
    ...(manifest === undefined ? {} : { manifest }),
    onError(error: unknown) {
      if (isProbe) {
        metadata.onProbeError?.();
      } else {
        renderError ??= { error };
      }
    },
    // Probe renders must not consume style dedupe keys the real render needs.
    onHead: isProbe
      ? () => undefined
      : (headHtml: string) => {
          head += headHtml;
        },
  });
  if (renderError !== undefined) {
    throw renderError.error;
  }

  // Serializer scripts already ride inside island markup, so extra non-marker nodes are safe for hydration.
  const styles = head !== '' && !isProbe ? extractIslandStyles(head, pageRenderState.claimStyle) : '';

  return {
    attrs: {
      'data-solid-render-id': renderId,
    },
    html: styles + componentHtml,
  };

  function renderWithSlots(): JSX.Element {
    const slots: Props = {};
    for (const [key, value] of Object.entries(slotted)) {
      const name = toSlotName(key);
      slots[name] = ssr(`<${tagName} name="${name}">${value}</${tagName}>`);
    }
    // A copy, because `props` must not change before it is serialized.
    const newProps: Props = {
      ...props,
      ...slots,
      children: children === undefined ? children : ssr(`<${tagName}>${children}</${tagName}>`),
    };

    if (needsHydrate) {
      return renderComponent(newProps);
    }
    // NoHydration covers only what renders under it, so the component runs inside it.
    return createComponent(NoHydration, {
      get children() {
        return renderComponent(newProps);
      },
    });
  }

  // No Suspense wrapper, since the stream settles every boundary before the HTML resolves.
  function renderComponent(componentProps: Props): JSX.Element {
    const value = createComponent(Component, componentProps);

    // Solid 2's SSR renders unknown objects as inert markers, so a foreign component could pass the probe. The
    // error fails it through onError.
    if (value !== null && typeof value === 'object' && '$$typeof' in value) {
      throw new Error(
        `${Component.name || 'An anonymous component'} is not a Solid component: it rendered a foreign framework vnode`,
      );
    }
    return value;
  }
}

async function getManifest(): Promise<Manifest | undefined> {
  if (manifestLoader === undefined) {
    try {
      manifestLoader = (await import('virtual:astro-solid-manifest')).loadManifest;
    } catch {
      // Outside Vite the virtual module does not resolve, so renders go on without asset resolution.
      manifestLoader = null;
    }
  }
  // The loader returns the client build's manifest JSON, untyped, whose shape is Solid's manifest.
  return (manifestLoader?.() ?? undefined) as Manifest | undefined;
}

// Lazy boundary CSS reaches an island only through onHead. Without it, server-rendered lazy content stays unstyled
// until its chunk loads. Deduped per page, so a shared chunk's CSS ships once.
function extractIslandStyles(head: string, claimStyle: PageRenderState['claimStyle']): string {
  let islandStyles = '';
  for (const tag of head.match(STYLE_OR_LINK_PATTERN) ?? []) {
    const key = getStyleKey(tag);
    if (key === undefined || !claimStyle(key)) {
      continue;
    }
    islandStyles += tag;
  }
  return islandStyles;
}

// A stylesheet link dedupes by its `href` and a style tag by its dev id, each falling back to the whole tag. A link
// that is no stylesheet has no key.
function getStyleKey(tag: string): string | undefined {
  if (!tag.startsWith('<link')) {
    const devId = /data-vite-dev-id=(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    return devId === null ? tag : (devId[1] ?? devId[2] ?? tag);
  }
  if (!/rel=(?:"stylesheet"|'stylesheet'|stylesheet\b)/i.test(tag)) {
    return undefined;
  }
  const href = /href=(?:"([^"]*)"|'([^']*)')/i.exec(tag);
  return href === null ? tag : (href[1] ?? href[2] ?? tag);
}

function toSlotName(key: string): string {
  return key.trim().replace(/[-_]([a-z])/g, (_, letter: string) => letter.toUpperCase());
}
