// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// `notes.read` and `notes.watch` with every payload as bytes, so a test can send what their codecs refuse.

import { Bytes, Result, _void } from 'scale-ts';
import { request } from '../request.js';
import { subscription } from '../subscription.js';

const bytes = Bytes(Infinity);
export const rawRead = request({ request: bytes, response: bytes, error: bytes });
export const rawWatch = subscription({ start: bytes, receive: bytes, interrupt: Result(_void, bytes) });
