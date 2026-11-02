// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The handshake's halves. The wire version that opens an offer never changes, so a peer of any release reads the
// versions it refuses. A hello stays bytes, since another release's may not decode.

import { Bytes, Result, Struct, u8, type CodecType } from 'scale-ts';
import { createEndingCodec } from './createEndingCodec.js';

// The wire version goes first, so a peer of any release reads it.
const versionsCodec = Struct({ wire: u8, schema: u8 });

/** The versions a side speaks: the library's own wire, and its schema's. */
export type TransportVersions = CodecType<typeof versionsCodec>;

/** The codec of a `HandshakeOffer`. */
export const handshakeOfferCodec = Struct({ versions: versionsCodec, hello: Bytes(Infinity) });

/** The codec of a `HandshakeResponse`. Its versions end before the frame does, so it refuses bytes after them. */
export const handshakeResponseCodec = Result(Bytes(Infinity), createEndingCodec(versionsCodec));

/** The opener's attempt: the versions it speaks and its hello. */
export type HandshakeOffer = CodecType<typeof handshakeOfferCodec>;

/** The accepter's answer: its hello, or the versions it speaks. */
export type HandshakeResponse = CodecType<typeof handshakeResponseCodec>;
