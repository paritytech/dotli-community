// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Method fixtures that cover a struct start and an enum failure.

import { Enum, Result, Struct, _void, str } from 'scale-ts';
import { callError } from '../callError.js';
import { request } from '../request.js';
import { subscription } from '../subscription.js';

const label = Struct({ label: str });
const frameFailure = Enum({ fatal: _void, released: _void });

export const owner = request({ request: label, response: str });
export const changes = subscription({ start: label, receive: str });
export const status = subscription({ start: _void, receive: _void, interrupt: frameFailure });
export const ended = subscription({ start: _void, receive: _void, interrupt: Result(_void, callError(frameFailure)) });
export const reload = request({ request: _void, response: _void, error: frameFailure });
