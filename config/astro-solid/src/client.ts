// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Astro's client entrypoint for Solid islands.

import { createSignal, merge, type Component } from 'solid-js';
import { createComponent, hydrate, render, type JSX } from '@solidjs/web';

type Props = Record<string, unknown>;

// Written out rather than derived, because it is Astro's call shape for a client entrypoint.
/** Mounts one island render from the component, its props, its slots' HTML and its client directive. */
type MountIsland = (
  Component: Component<never>,
  props: Props,
  slotted: Record<string, string>,
  directive: { client: string },
  // eslint-disable-next-line @typescript-eslint/max-params -- Astro's island hydrator call fixes this signature
) => void;

const alreadyInitializedElements = new WeakMap<Element, (props: Props) => void>();

/**
 * Returns the function Astro calls to hydrate, or for `client:only` render, a Solid island in `element`.
 *
 * The returned function does nothing until the element has its `ssr` attribute, updates the props in place when called
 * again for the same element, and throws whatever the component throws while it first renders.
 */
export default function hydrateIsland(element: HTMLElement): MountIsland {
  return mountIsland;

  // eslint-disable-next-line @typescript-eslint/max-params -- Astro's island hydrator call fixes this signature
  function mountIsland(
    Component: Component<never>,
    props: Props,
    slotted: Record<string, string>,
    { client }: { client: string },
  ): void {
    if (!element.hasAttribute('ssr')) {
      return;
    }
    const isHydrate = client !== 'only';

    const { default: children, ...slots } = collectSlotElements(slotted, isHydrate);
    const renderId = element.dataset['solidRenderId'];
    const setProps = alreadyInitializedElements.get(element);
    if (setProps !== undefined) {
      setProps({ ...props, ...slots, children });
      return;
    }

    // A signal, not a store, which would put Solid's store module on the page. merge() makes prop reads track it.
    const [current, setCurrent] = createSignal<Props>({ ...props, ...slots, children });
    alreadyInitializedElements.set(element, next => {
      setCurrent(next);
    });
    // Made before hydrate(): the merge's memo would take a hydration id,
    // which the server render never gave out.
    const reactiveProps: Props = merge(() => current());

    // No boundary wrapper, since hydration structure must match the server's markup exactly. Components that want a
    // fallback bring their own Loading boundary.
    // Astro hands over any component type with the props it was rendered with, which `never` cannot name.
    const renderComponent = (): JSX.Element => createComponent(Component as Component<Props>, reactiveProps);

    let dispose: () => void;
    if (isHydrate) {
      dispose = hydrate(renderComponent, element, renderId === undefined ? {} : { renderId });
    } else {
      // render() appends to existing children, so clear the fallback first.
      element.innerHTML = '';
      dispose = render(renderComponent, element);
    }
    element.addEventListener(
      'astro:unmount',
      () => {
        dispose();
      },
      { once: true },
    );
  }

  // A hydrating island reuses the slots the server rendered, and every slot it lacks is made from its HTML.
  function collectSlotElements(slotted: Record<string, string>, isHydrate: boolean): Record<string, HTMLElement> {
    if (Object.keys(slotted).length === 0) {
      return {};
    }
    const slotElements: Record<string, HTMLElement> = isHydrate ? findRenderedSlots() : {};
    for (const [key, value] of Object.entries(slotted)) {
      if (key in slotElements) {
        continue;
      }
      const slotElement = document.createElement('astro-slot');
      if (key !== 'default') {
        slotElement.setAttribute('name', key);
      }
      slotElement.innerHTML = value;
      slotElements[key] = slotElement;
    }
    return slotElements;
  }

  // Nested islands own their slots, so the walk skips them.
  function findRenderedSlots(): Record<string, HTMLElement> {
    const slotElements: Record<string, HTMLElement> = {};
    const iterator = document.createTreeWalker(element, NodeFilter.SHOW_ELEMENT, node => {
      if (node === element) {
        return NodeFilter.FILTER_SKIP;
      }
      if (node.nodeName === 'ASTRO-SLOT') {
        return NodeFilter.FILTER_ACCEPT;
      }
      if (node.nodeName === 'ASTRO-ISLAND') {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_SKIP;
    });
    let slot: Node | null;
    while ((slot = iterator.nextNode()) !== null) {
      if (!(slot instanceof HTMLElement)) {
        continue;
      }
      slotElements[slot.getAttribute('name') ?? 'default'] = slot;
    }
    return slotElements;
  }
}
