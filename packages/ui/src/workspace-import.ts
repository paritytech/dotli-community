// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Backend } from "@dotli/config/mode";
import { getActiveTldSuffix, withActiveTld } from "@dotli/config/network";
import { packArchive, type PackedArchive } from "@dotli/content/archive";
import { bitswapGet } from "@dotli/content/bitswap";
import { fetchArchive } from "@dotli/content/fetch";
import { resolveAppContenthash } from "@dotli/resolver/app-content";
import { WORKSPACE_LIMITS } from "@dotli/shared/workspace-limits";

export interface WorkspaceImportRequest {
  type: "dotli:workspace-import";
  address: string;
}

export interface ChainWorkspaceArchive extends PackedArchive {
  name: string;
  cid: string;
}

export type WorkspaceImportMessage =
  | { type: "ready" }
  | { type: "progress"; message: string }
  | { type: "complete"; archive: ChainWorkspaceArchive }
  | { type: "error"; message: string };

export interface WorkspaceImportContext {
  source: Window;
  origin: string;
  /** Stable identity of the active, workspace-capable product host. */
  owner: object;
  backend: Backend;
}

/** Resolves once, then copies verified deployed bytes. Never boots the app. */
export async function fetchChainWorkspaceArchive(
  address: string,
  backend: Backend,
  onStatus: (message: string) => void,
  signal: AbortSignal,
): Promise<ChainWorkspaceArchive> {
  signal.throwIfAborted();
  const suffix = getActiveTldSuffix();
  const normalized = address.trim().toLowerCase();
  const label = normalized.endsWith(suffix)
    ? normalized.slice(0, -suffix.length)
    : "";
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) {
    throw new Error(
      `Enter a product address such as name${suffix}. Import uses the currently selected network; it never switches networks.`,
    );
  }
  const name = withActiveTld(label);
  onStatus(`Resolving ${name}…`);
  const cid = await resolveAppContenthash(label, backend, onStatus);
  signal.throwIfAborted();
  if (cid === null) throw new Error(`No deployed content found for ${name}.`);
  onStatus(`Fetching and verifying ${name} · ${cid}`);
  const result = await fetchArchive(cid, onStatus, {
    useGateway: backend === "rpc-gateway",
    bitswapBlockSource:
      backend === "rpc-gateway"
        ? undefined
        : (blockCid) => bitswapGet(blockCid, signal),
    signal,
  });
  signal.throwIfAborted();
  const files =
    result.type === "archive" ? result.files : { "index.html": result.content };
  const entries = Object.entries(files);
  if (entries.length === 0 || entries.length > WORKSPACE_LIMITS.maxFiles) {
    throw new Error(
      `${name} contains ${entries.length} files; a workspace supports 1–${WORKSPACE_LIMITS.maxFiles}. Nothing was imported.`,
    );
  }
  for (const [path, bytes] of entries) {
    if (bytes.byteLength > WORKSPACE_LIMITS.maxFileBytes) {
      throw new Error(
        `${path} is ${bytes.byteLength.toLocaleString()} bytes and exceeds the 1 MiB per-file limit. Nothing was imported.`,
      );
    }
  }
  return { name, cid, ...packArchive(files) };
}

/** One private reply port per request; only the active authorized frame can start it. */
export function installWorkspaceImportBridge(
  current: () => WorkspaceImportContext | null,
): () => void {
  let active: {
    owner: object;
    controller: AbortController;
    port: MessagePort;
  } | null = null;
  const cancel = (): void => {
    active?.controller.abort();
    active?.port.close();
    active = null;
  };
  const receive = (event: MessageEvent<unknown>): void => {
    const data = event.data;
    if (
      typeof data !== "object" ||
      data === null ||
      !("type" in data) ||
      data.type !== "dotli:workspace-import"
    )
      return;
    const context = current();
    const port = event.ports[0];
    if (
      context === null ||
      event.source !== context.source ||
      event.origin !== context.origin ||
      event.ports.length !== 1 ||
      port === undefined
    ) {
      port?.close();
      return;
    }
    const reply = (message: WorkspaceImportMessage): void =>
      port.postMessage(message);
    if (
      !("address" in data) ||
      typeof data.address !== "string" ||
      data.address.length > 256
    ) {
      reply({ type: "error", message: "Invalid chain import address." });
      port.close();
      return;
    }
    if (active !== null && active.owner !== context.owner) cancel();
    if (active !== null) {
      reply({
        type: "error",
        message: "A chain import is already in progress.",
      });
      port.close();
      return;
    }
    const controller = new AbortController();
    const request = { owner: context.owner, controller, port };
    active = request;
    const stillCurrent = (): boolean => {
      const next = current();
      return (
        !controller.signal.aborted &&
        next?.owner === context.owner &&
        next.source === context.source &&
        next.origin === context.origin &&
        next.backend === context.backend
      );
    };
    port.onmessage = (message: MessageEvent<unknown>) => {
      const data = message.data;
      if (
        typeof data === "object" &&
        data !== null &&
        "type" in data &&
        data.type === "cancel" &&
        active === request
      )
        cancel();
    };
    reply({ type: "ready" });
    void fetchChainWorkspaceArchive(
      data.address,
      context.backend,
      (message) => {
        if (!stillCurrent()) {
          controller.abort();
          return;
        }
        reply({ type: "progress", message });
      },
      controller.signal,
    )
      .then((archive) => {
        if (stillCurrent()) {
          port.postMessage(
            { type: "complete", archive } satisfies WorkspaceImportMessage,
            [archive.packed],
          );
        }
      })
      .catch((error: unknown) => {
        if (stillCurrent())
          reply({
            type: "error",
            message: error instanceof Error ? error.message : String(error),
          });
      })
      .finally(() => {
        port.close();
        if (active === request) active = null;
      });
  };
  window.addEventListener("message", receive);
  window.addEventListener("pagehide", cancel);
  return () => {
    window.removeEventListener("message", receive);
    window.removeEventListener("pagehide", cancel);
    cancel();
  };
}
