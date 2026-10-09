// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Astro's server entrypoint for Solid components.

import { createComponent, generateHydrationScript, NoHydration, renderToStream, ssr } from '@solidjs/web';
import type { Component } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { NamedSSRLoadedRendererValue } from 'astro';
import { getContext, incrementId } from './context.js';
import type { RendererContext } from './types.js';

type Props = Record<string, unknown>;
type Manifest = NonNullable<NonNullable<Parameters<typeof renderToStream>[1]>['manifest']>;

interface Metadata {
  hydrate?: string;
  astroStaticSlot?: boolean;
  renderStrategy?: 'default' | 'probe';
  onProbeError?: () => void;
}

const slotName = (str: string): string => str.trim().replace(/[-_]([a-z])/g, (_, w: string) => w.toUpperCase());

// Resolves lazy boundary module URLs. Outside Vite (the Container API) the import fails and rendering goes on without
// asset resolution.
let manifestLoader: (() => unknown) | null | undefined;
async function getManifest(): Promise<Manifest | undefined> {
  if (manifestLoader === undefined) {
    try {
      manifestLoader = (await import('virtual:astro-solid-manifest')).loadManifest;
    } catch {
      manifestLoader = null;
    }
  }
  return (manifestLoader?.() ?? undefined) as Manifest | undefined;
}

// Probe verdicts are stable per component, so the probe's async work runs once per type.
const checkCache = new WeakMap<object, boolean>();

const STYLE_OR_LINK_RE = /<style\b[^>]*>[\s\S]*?<\/style>|<link\b[^>]*>/gi;

// Lazy boundary CSS reaches an island only through onHead. Without it, server-rendered lazy content stays unstyled
// until its chunk loads. Deduped per page, so a shared chunk's CSS ships once.
function extractIslandStyles(head: string, seen: Set<string>): string {
  let out = '';
  for (const tag of head.match(STYLE_OR_LINK_RE) ?? []) {
    let key: string;
    if (tag.startsWith('<link')) {
      if (!/rel=(?:"stylesheet"|'stylesheet'|stylesheet\b)/i.test(tag)) {
        continue;
      }
      const href = /href=(?:"([^"]*)"|'([^']*)')/i.exec(tag);
      key = href === null ? tag : (href[1] ?? href[2] ?? tag);
    } else {
      const devId = /data-vite-dev-id=(?:"([^"]*)"|'([^']*)')/i.exec(tag);
      key = devId === null ? tag : (devId[1] ?? devId[2] ?? tag);
    }
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out += tag;
  }
  return out;
}

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

  let result = false;
  if (Component.name !== 'QwikComponent') {
    // Solid renders a Svelte component as an empty string, so this copies the Svelte renderer's check
    // (`$$payload` before Svelte 5, `$$renderer` since). `Component.toString()` would trip Proxy `get` traps.
    let componentStr = '';
    try {
      componentStr = Function.prototype.toString.call(Component);
      // eslint-disable-next-line no-restricted-syntax -- no source to read (a revoked Proxy, an exotic callable): the probe render below decides.
    } catch {
      /* no source to read: the probe render below decides */
    }
    if (!componentStr.includes('$$payload') && !componentStr.includes('$$renderer')) {
      // Solid components are plain functions, so probe-render and reject anything that errors. A stream render,
      // because a sync render of an async component throws and orphans promise rejections.
      let errored = false;
      try {
        const { html } = await renderToStaticMarkup.call(this, Component as Component<Props>, props, children, {
          renderStrategy: 'probe',
          onProbeError() {
            errored = true;
          },
        });
        result = typeof html === 'string' && !errored;
      } catch {
        result = false;
      }
    }
  }

  checkCache.set(Component, result);
  return result;
}

async function renderToStaticMarkup(
  this: RendererContext,
  Component: Component<Props>,
  props: Props,
  { default: children, ...slotted }: Record<string, string>,
  metadata?: Metadata,
): Promise<{ attrs: Record<string, string>; html: string }> {
  const ctx = getContext(this.result);
  const renderId = metadata?.hydrate !== undefined ? incrementId(ctx) : '';
  const needsHydrate = metadata?.astroStaticSlot === true ? metadata.hydrate !== undefined : true;
  const tagName = needsHydrate ? 'astro-slot' : 'astro-static-slot';

  const isProbe = metadata?.renderStrategy === 'probe';

  const renderFn = (): JSX.Element => {
    const slots: Props = {};
    for (const [key, value] of Object.entries(slotted)) {
      const name = slotName(key);
      slots[name] = ssr(`<${tagName} name="${name}">${value}</${tagName}>`);
    }
    // A copy, because `props` must not change before it is serialized.
    const newProps: Props = {
      ...props,
      ...slots,
      children: children === undefined ? children : ssr(`<${tagName}>${children}</${tagName}>`),
    };

    // No Suspense wrapper, since the stream settles every boundary before the HTML resolves.
    const renderComponent = (): JSX.Element => {
      const value = createComponent(Component, newProps);

      // Solid 2's SSR renders unknown objects as inert markers, so a foreign component could pass the probe. The
      // error fails it through onError.
      if (value !== null && typeof value === 'object' && '$$typeof' in value) {
        throw new Error('Not a Solid component: rendered a foreign framework vnode');
      }
      return value;
    };

    if (needsHydrate) {
      return renderComponent();
    }
    // NoHydration covers only what renders under it, so the component runs inside it.
    return createComponent(NoHydration, {
      get children() {
        return renderComponent();
      },
    });
  };

  // The stream never rejects. Uncontained errors surface through onError and are rethrown for real renders, so Astro
  // can report them.
  let renderError: { error: unknown } | undefined;
  let head = '';
  const manifest = await getManifest();
  const componentHtml = await renderToStream(renderFn, {
    renderId,
    noScripts: !needsHydrate || isProbe,
    ...(manifest === undefined ? {} : { manifest }),
    onError(err: unknown) {
      if (isProbe) {
        metadata.onProbeError?.();
      } else {
        renderError ??= { error: err };
      }
    },
    // Probe renders must not consume style dedupe keys the real render needs.
    onHead: isProbe
      ? () => undefined
      : (h: string) => {
          head += h;
        },
  });
  if (renderError !== undefined) {
    throw renderError.error;
  }

  // Serializer scripts already ride inside island markup, so extra non-marker nodes are safe for hydration.
  const styles = head !== '' && !isProbe ? extractIslandStyles(head, ctx.styles) : '';

  return {
    attrs: {
      'data-solid-render-id': renderId,
    },
    html: styles + componentHtml,
  };
}

const renderer: NamedSSRLoadedRendererValue = {
  name: '@config/astro-solid',
  check,
  renderToStaticMarkup,
  supportsAstroStaticSlot: true,
  renderHydrationScript: () => generateHydrationScript(),
};

export default renderer;
