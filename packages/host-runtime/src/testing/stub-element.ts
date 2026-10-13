// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The few element behaviours the product frame relies on, so its specs run without a DOM: children, `dataset`,
// connection to the page, and an iframe's own window as an opaque token.

export class StubElement {
  readonly tagName: string;
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  /** An iframe's window, compared by identity only. */
  readonly contentWindow: object | null;
  parent: StubElement | null = null;
  children: StubElement[] = [];
  private readonly root: boolean;

  /** A `root` is in the page, as the host's `#app` is. */
  constructor(tagName: string, { root = false }: { root?: boolean } = {}) {
    this.tagName = tagName.toUpperCase();
    this.root = root;
    this.contentWindow = this.tagName === 'IFRAME' ? {} : null;
  }

  get isConnected(): boolean {
    return this.root || this.parent?.isConnected === true;
  }

  get parentElement(): StubElement | null {
    return this.parent;
  }

  get firstElementChild(): StubElement | null {
    return this.children[0] ?? null;
  }

  /** Only the empty string, which clears the element. */
  set innerHTML(_html: '') {
    for (const child of this.children) {
      child.parent = null;
    }
    this.children = [];
  }

  appendChild(child: StubElement): StubElement {
    child.remove();
    child.parent = this;
    this.children.push(child);
    return child;
  }

  remove(): void {
    if (this.parent !== null) {
      this.parent.children = this.parent.children.filter(c => c !== this);
      this.parent = null;
    }
  }

  /** `iframe` among the descendants, or `:scope > [data-error-page]` among the children. */
  querySelectorAll(selector: 'iframe' | ':scope > [data-error-page]'): StubElement[] {
    if (selector === ':scope > [data-error-page]') {
      return this.children.filter(child => 'errorPage' in child.dataset);
    }
    return this.children.flatMap(child => [
      ...(child.tagName === 'IFRAME' ? [child] : []),
      ...child.querySelectorAll('iframe'),
    ]);
  }

  querySelector(selector: 'iframe'): StubElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  addEventListener(): void {}

  /** As the DOM type the frame's deps take. */
  asHtml(): HTMLElement {
    return this as unknown as HTMLElement;
  }

  asIframe(): HTMLIFrameElement {
    return this as unknown as HTMLIFrameElement;
  }
}
