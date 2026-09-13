// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { CarWriter } from "@ipld/car";
import * as dagPb from "@ipld/dag-pb";
import type { PBLink } from "@ipld/dag-pb";
import type { Page } from "@playwright/test";
import { UnixFS } from "ipfs-unixfs";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";

export interface TestCar {
  cid: string;
  bytes: Uint8Array;
}

/** Build the flat UnixFS directory CAR consumed by the sandbox archive reader. */
export async function archiveCar(
  sourceFiles: readonly (readonly [string, Uint8Array])[],
): Promise<TestCar> {
  const files = await Promise.all(
    sourceFiles.map(async ([name, bytes]) => ({
      name,
      bytes,
      cid: CID.createV1(raw.code, await sha256.digest(bytes)),
    })),
  );
  const links: PBLink[] = files
    .map(({ name, bytes, cid }) => ({
      Name: name,
      Tsize: bytes.length,
      Hash: cid,
    }))
    .sort((left, right) => (left.Name ?? "").localeCompare(right.Name ?? ""));
  const rootBytes = dagPb.encode({
    Data: new UnixFS({ type: "directory" }).marshal(),
    Links: links,
  });
  const root = CID.createV1(dagPb.code, await sha256.digest(rootBytes));
  const { writer, out } = CarWriter.create([root]);
  const chunksPromise = (async (): Promise<Uint8Array[]> => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of out) chunks.push(chunk);
    return chunks;
  })();
  for (const { cid, bytes } of files) await writer.put({ cid, bytes });
  await writer.put({ cid: root, bytes: rootBytes });
  await writer.close();
  const chunks = await chunksPromise;
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const car = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    car.set(chunk, offset);
    offset += chunk.length;
  }
  return { cid: root.toString(), bytes: car };
}

/** Answer the sandbox's TrUAPI readiness probe as the host shell does. */
export async function installTruapiPortResponder(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const channel = new MessageChannel();
    const scope = window as typeof window & {
      __HOST_API_PORT__?: MessagePort;
    };
    channel.port2.onmessage = (event) => {
      if (!(event.data instanceof Uint8Array)) {
        return;
      }
      const request = event.data;
      const first = request[0];
      if (first === undefined || (first & 3) !== 0) {
        return;
      }
      const kindOffset = 1 + (first >> 2);
      if (
        request.length !== kindOffset + 3 ||
        request[kindOffset] !== 0 ||
        request[kindOffset + 1] !== 0 ||
        request[kindOffset + 2] !== 1
      ) {
        return;
      }
      const response = new Uint8Array(kindOffset + 3);
      response.set(request.subarray(0, kindOffset));
      response[kindOffset] = 1;
      response[kindOffset + 1] = 0;
      response[kindOffset + 2] = 0;
      channel.port2.postMessage(response, [response.buffer]);
    };
    channel.port2.start();
    scope.__HOST_API_PORT__ = channel.port1;
  });
}

/** Issue a fresh TrUAPI port whenever a product restarts in the same iframe. */
export async function installRepeatedTruapiPortResponder(
  page: Page,
  allowedOrigin: string,
): Promise<void> {
  await page.evaluate((allowedOrigin) => {
    const scope = window as typeof window & {
      __dotliTestPortsIssued?: number;
    };
    scope.__dotliTestPortsIssued = 0;
    window.addEventListener("message", (event) => {
      if (
        event.data?.type !== "truapi-ready" ||
        event.source === null ||
        event.origin !== allowedOrigin
      ) {
        return;
      }
      const channel = new MessageChannel();
      channel.port2.onmessage = (portEvent) => {
        if (!(portEvent.data instanceof Uint8Array)) {
          return;
        }
        const request = portEvent.data;
        const first = request[0];
        if (first === undefined || (first & 3) !== 0) {
          return;
        }
        const kindOffset = 1 + (first >> 2);
        if (
          request.length !== kindOffset + 3 ||
          request[kindOffset] !== 0 ||
          request[kindOffset + 1] !== 0 ||
          request[kindOffset + 2] !== 1
        ) {
          return;
        }
        const response = new Uint8Array(kindOffset + 3);
        response.set(request.subarray(0, kindOffset));
        response[kindOffset] = 1;
        channel.port2.postMessage(response, [response.buffer]);
      };
      channel.port2.start();
      scope.__dotliTestPortsIssued = (scope.__dotliTestPortsIssued ?? 0) + 1;
      event.source.postMessage(
        { type: "truapi-init" },
        {
          targetOrigin: event.origin,
          transfer: [channel.port1],
        },
      );
    });
  }, allowedOrigin);
}
