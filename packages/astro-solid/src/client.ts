// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Astro's client entrypoint for Solid islands: hydrates the server-rendered
// island (or renders a `client:only` one) and applies later prop updates.

import { createStore, reconcile, type Component, type StoreSetter } from 'solid-js';
import { createComponent, hydrate, render, type JSX } from '@solidjs/web';

type Props = Record<string, unknown>;
const alreadyInitializedElements = new WeakMap<Element, StoreSetter<Props>>();

export default (element: HTMLElement) =>
  (Component: Component<never>, props: Props, slotted: Record<string, string>, { client }: { client: string }) => {
    if (!element.hasAttribute('ssr')) {
      return;
    }
    const isHydrate = client !== 'only';

    const _slots: Record<string, HTMLElement> = {};
    if (Object.keys(slotted).length > 0) {
      // hydratable
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
      // update the mounted component
      setProps(
        // reconcile will make sure to apply as little updates as possible, and also remove missing values w/o breaking reactivity
        reconcile({ ...props, ...slots, children }),
      );
    } else {
      const [store, setStore] = createStore<Props>({ ...props, ...slots, children });
      // store the function to update the current mounted component
      alreadyInitializedElements.set(element, setStore);

      // No boundary wrapper: the server render ships fully-settled HTML with
      // no boundary of its own, and hydration structure must match. Async is
      // first-class in Solid 2.0; components that want a fallback bring
      // their own Loading boundary (present in both renders).
      const fn = (): JSX.Element => createComponent(Component as Component<Props>, store);

      let dispose: () => void;
      if (isHydrate) {
        dispose = hydrate(fn, element, renderId === undefined ? {} : { renderId });
      } else {
        // For client:only, clear the fallback content before rendering.
        // Solid's render() appends rather than replaces when existing children are present.
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
