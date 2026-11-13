// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Enum, _void, type Codec } from 'scale-ts';
import { createWholeDecoder } from './createWholeDecoder.js';
import { toMessageBytes } from './messageBytes.js';
import { createMethod, type Subscription } from './method.js';

type Params<Start, Value, Interrupt> = {
  start: Codec<Start>;
  receive: Codec<Value>;
  interrupt: Codec<Interrupt>;
};

// A leg's payload is read as nothing, so reading a message's leg reads only its tag and copies no payload.
const voidSubscriptionLegs = createSubscriptionLegs({ start: _void, receive: _void, interrupt: _void });

/** The stop of any subscription, which carries nothing, so a side that decodes none of its messages can send it. */
export const SUBSCRIPTION_STOP = toMessageBytes(voidSubscriptionLegs.enc({ tag: 'stop', value: undefined }));

/** Reads a subscription message's leg and refuses bytes left unread, so a stop is checked with no payload codec. */
export const wholeSubscriptionLeg = createWholeDecoder(voidSubscriptionLegs);

/**
 * Declares a subscription. `interrupt` is the method's own interrupt reason, which crosses as it is with nothing added,
 * and one without it has an empty one. A schema that wants truapi's layout declares `Result(_void, callError(reason))`.
 *
 * @example
 * const watchAccount = subscription({ start: str, receive: u32, interrupt: Result(_void, callError(str)) });
 */
export function subscription<Start, Value>(definition: {
  start: Codec<Start>;
  receive: Codec<Value>;
}): Subscription<Start, Value, undefined>;
export function subscription<Start, Value, Interrupt>(definition: {
  start: Codec<Start>;
  receive: Codec<Value>;
  interrupt: Codec<Interrupt>;
}): Subscription<Start, Value, Interrupt>;
export function subscription<Start, Value, Interrupt>(definition: {
  start: Codec<Start>;
  receive: Codec<Value>;
  interrupt?: Codec<Interrupt>;
}): Subscription<Start, Value, Interrupt> | Subscription<Start, Value, undefined> {
  return definition.interrupt === undefined
    ? createSubscription(definition, _void)
    : createSubscription(definition, definition.interrupt);
}

/** The subscription of `definition` whose own interrupt reason is `interrupt`. */
function createSubscription<Start, Value, Interrupt>(
  definition: { start: Codec<Start>; receive: Codec<Value> },
  interrupt: Codec<Interrupt>,
): Subscription<Start, Value, Interrupt> {
  return createMethod(
    createSubscriptionLegs({ start: definition.start, receive: definition.receive, interrupt }),
    voidSubscriptionLegs.dec,
  );
}

// A subscription's legs in wire order, so its message and the reader of its leg share one layout.
function createSubscriptionLegs<Start, Value, Interrupt>({
  start,
  receive,
  interrupt,
}: Params<Start, Value, Interrupt>) {
  return Enum({ start, receive, interrupt, stop: _void });
}
