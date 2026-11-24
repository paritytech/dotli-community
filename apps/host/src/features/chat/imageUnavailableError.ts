// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Why an image cannot be drawn:
 * - `not_connected`: the product has no live connection to read it through
 * - `too_large`: more bytes than its source may carry
 * - `unsupported_type`: bytes of no type its source may carry
 * - `undecodable`: bytes the browser cannot decode
 * - `missing`: the backend or the archive has no bytes for it
 * - `mismatch`: bytes that do not hash to their CID
 * - `fetch`: the backend or the archive read failed
 * - `no_archive`: the product publishes no archive to read it from
 * - `unsupported_cid`: a CID that is not one raw block
 */
export type ImageUnavailableReason =
  | 'not_connected'
  | 'too_large'
  | 'unsupported_type'
  | 'undecodable'
  | 'missing'
  | 'mismatch'
  | 'fetch'
  | 'no_archive'
  | 'unsupported_cid';

/** An image a custom message names that cannot be drawn, for `reason`. */
export class ImageUnavailableError extends Error {
  override name = 'ImageUnavailableError';
  readonly reason: ImageUnavailableReason;

  constructor(reason: ImageUnavailableReason, message: string, options?: ErrorOptions) {
    super(message, options);
    this.reason = reason;
  }
}
