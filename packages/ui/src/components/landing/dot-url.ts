// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { BASE_DOMAIN } from "@dotli/config";

/**
 * The site of the `.dot` name `label`: its `.localhost` subdomain on this port
 * in local development, its subdomain of the base domain otherwise.
 */
export function dotUrl(label: string): string {
  const host = window.location.hostname;
  if (host.endsWith(".localhost") || host === "localhost") {
    return `${window.location.protocol}//${label}.localhost:${window.location.port}`;
  }
  return `https://${label}.${BASE_DOMAIN}`;
}
