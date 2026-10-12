// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Backend } from "@dotli/config/mode";
import { withActiveTld } from "@dotli/config/network";
import {
  resolveDotNameRemote,
  resolveExecutableManifestRemote,
} from "@dotli/protocol/client";
import { log } from "@dotli/shared/log";
import type { ExecutableManifest, ManifestResult } from "./manifest";

export async function resolveAppExecutableManifest(
  label: string,
  chainBackend: Backend,
): Promise<ManifestResult<ExecutableManifest>> {
  if (chainBackend === "rpc-gateway") {
    const mod = await import("./rpc-resolve");
    return mod.resolveExecutableManifestViaRpc(label, "app");
  }
  return resolveExecutableManifestRemote(label, "app");
}

export async function resolveAppContenthash(
  label: string,
  chainBackend: Backend,
  onProgress?: (message: string) => void,
): Promise<string | null> {
  let contenthash: string | null;
  if (chainBackend === "rpc-gateway") {
    const { resolveDotNameViaRpc } = await import("./rpc-resolve");
    contenthash = await resolveDotNameViaRpc(`app.${label}`, onProgress);
    contenthash ??= await resolveDotNameViaRpc(label, onProgress);
  } else {
    contenthash = await resolveDotNameRemote(`app.${label}`, onProgress);
    contenthash ??= await resolveDotNameRemote(label, onProgress);
  }
  if (contenthash === null) {
    log.warn(
      `[dot.li resolve] neither app.${withActiveTld(label)} nor ${withActiveTld(label)} has a contenthash`,
    );
  }
  return contenthash;
}
