// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// DOM queries and waits for functional tests, which run under happy-dom.

import { must, untilDom } from '@dotli/shared/testing';

type ElementClass<E extends Element> = abstract new (...args: never[]) => E;

function asElement<E extends Element>(node: Element | null, type: ElementClass<E>, what: string): E {
  const element = must(node, what);
  if (!(element instanceof type)) {
    throw new Error(`expected ${what} to be a ${type.name}`);
  }
  return element;
}

export function byId(id: string): HTMLElement;
export function byId<E extends Element>(id: string, type: ElementClass<E>): E;
export function byId(id: string, type: ElementClass<Element> = HTMLElement): Element {
  return asElement(document.getElementById(id), type, `#${id}`);
}

export function query(root: ParentNode, selector: string): HTMLElement;
export function query<E extends Element>(root: ParentNode, selector: string, type: ElementClass<E>): E;
export function query(root: ParentNode, selector: string, type: ElementClass<Element> = HTMLElement): Element {
  return asElement(root.querySelector(selector), type, `"${selector}"`);
}

export function byTestId(id: string, root?: ParentNode): HTMLElement;
export function byTestId<E extends Element>(id: string, root: ParentNode, type: ElementClass<E>): E;
export function byTestId(id: string, root: ParentNode = document, type: ElementClass<Element> = HTMLElement): Element {
  return query(root, `[data-testid="${id}"]`, type);
}

/** Resolves with the first element matching `selector` once the document has one. */
export async function appears(selector: string): Promise<HTMLElement> {
  await untilDom(() => document.querySelector(selector) !== null);
  return query(document, selector);
}
