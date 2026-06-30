// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A tiny listener bookkeeper. The topbar wires many `addEventListener` calls
// on long-lived targets (window, document) inside short-lived scopes (an open
// dropdown, a mounted panel). Registering them here means a single
// `disposeAll()` tears every one back down, instead of hand-matching each
// `removeEventListener` (the pattern that previously leaked when a scope was
// re-entered before its ad-hoc cleanup ran).

type Disposer = () => void;

export class EventManager {
  private disposers: Disposer[] = [];

  /**
   * Register an event listener and remember how to remove it. The same
   * `options` value is threaded to both add and remove so capture/passive
   * listeners are matched correctly.
   */
  on<K extends keyof DocumentEventMap>(
    target: Document,
    type: K,
    listener: (event: DocumentEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions,
  ): Disposer;
  on<K extends keyof WindowEventMap>(
    target: Window,
    type: K,
    listener: (event: WindowEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions,
  ): Disposer;
  on<K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    listener: (event: HTMLElementEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions,
  ): Disposer;
  on(
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): Disposer {
    target.addEventListener(type, listener, options);
    const dispose = (): void => {
      target.removeEventListener(type, listener, options);
    };
    this.disposers.push(dispose);
    return dispose;
  }

  /** Register an arbitrary teardown callback (timers, subscriptions, …). */
  add(disposer: Disposer): void {
    this.disposers.push(disposer);
  }

  /** Run and forget every registered disposer. Safe to call repeatedly. */
  disposeAll(): void {
    for (const dispose of this.disposers.splice(0)) {
      dispose();
    }
  }

  /** How many disposers are currently registered (useful in tests). */
  get size(): number {
    return this.disposers.length;
  }
}
