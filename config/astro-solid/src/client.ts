// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Astro's client entrypoint for Solid islands.

import { createSignal, merge, type Component } from 'solid-js';
import { createComponent, hydrate, render, type JSX } from '@solidjs/web';

type Props = Record<string, unknown>;
const alreadyInitializedElements = new WeakMap<Element, (props: Props) => void>();

export default (element: HTMLElement) =>
  (Component: Component<never>, props: Props, slotted: Record<string, string>, { client }: { client: string }) => {
    if (!element.hasAttribute('ssr')) {
      return;
    }
    const isHydrate = client !== 'only';

    const _slots: Record<string, HTMLElement> = {};
    if (Object.keys(slotted).length > 0) {
      if (client !== 'only') {
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
          const el = slot as HTMLElement;
          _slots[el.getAttribute('name') ?? 'default'] = el;
        }
      }
      for (const [key, value] of Object.entries(slotted)) {
        if (key in _slots) {
          continue;
        }
        const el = document.createElement('astro-slot');
        if (key !== 'default') {
          el.setAttribute('name', key);
        }
        el.innerHTML = value;
        _slots[key] = el;
      }
    }

    const { default: children, ...slots } = _slots;
    const renderId = element.dataset['solidRenderId'];
    const setProps = alreadyInitializedElements.get(element);
    if (setProps !== undefined) {
      setProps({ ...props, ...slots, children });
    } else {
      // A signal, not a store, which would put Solid's store module on the page. merge() makes prop reads track it.
      const [current, setCurrent] = createSignal<Props>({ ...props, ...slots, children });
      alreadyInitializedElements.set(element, next => {
        setCurrent(next);
      });
      // Made before hydrate(): the merge's memo would take a hydration id,
      // which the server render never gave out.
      const reactiveProps: Props = merge(() => current());

      // No boundary wrapper, because the server render has none and hydration structure must match. Components that
      // want a fallback bring their own Loading boundary.
      const fn = (): JSX.Element => createComponent(Component as Component<Props>, reactiveProps);

      let dispose: () => void;
      if (isHydrate) {
        dispose = hydrate(fn, element, renderId === undefined ? {} : { renderId });
      } else {
        // render() appends to existing children, so clear the fallback first.
        element.innerHTML = '';
        dispose = render(fn, element);
      }
      element.addEventListener(
        'astro:unmount',
        () => {
          dispose();
        },
        { once: true },
      );
    }
  };
