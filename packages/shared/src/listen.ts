// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Event listening that hands back its own stop, so a caller keeps one function instead of the handler and its type.

type Params<Target extends EventTarget, Type extends string> = {
  target: Target;
  type: Type;
  handler: (event: EventOf<Target, Type>) => void;
};

/** The events a target fires by name, as the DOM types them for a window, a document or the cookie store. */
type EventMapOf<Target> = Target extends Window
  ? WindowEventMap
  : Target extends Document
    ? DocumentEventMap
    : Target extends CookieStore
      ? CookieStoreEventMap
      : Record<string, Event>;

/** The event `Type` on `Target`, or a plain `Event` for a name its map does not know. */
type EventOf<Target, Type extends string> = Type extends keyof EventMapOf<Target> ? EventMapOf<Target>[Type] : Event;

/** Calls `handler` for each `type` event on `target` until the returned stop. */
export function listen<Target extends EventTarget, Type extends string>({
  target,
  type,
  handler,
}: Params<Target, Type>): () => void {
  // The DOM types a listener by its event only on the target's own overloads.
  const listener = handler as EventListener;
  target.addEventListener(type, listener);
  return () => {
    target.removeEventListener(type, listener);
  };
}
