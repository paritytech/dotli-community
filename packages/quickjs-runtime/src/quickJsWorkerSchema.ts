// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the page and the Web Worker that runs its VM say to each other. The page's first message transfers two ports:
// one the transport schema runs on, and the byte wire's. New sections and methods go at the end, and any change to
// them bumps the version.

import { isRecord } from '@dotli/shared';
import { defineSchema, request, subscription } from '@dotli/transport';
import { Bytes, Enum, Struct, Tuple, Vector, _void, bool, enhanceCodec, str, type CodecType } from 'scale-ts';

import type { ModuleFiles } from './createModuleLoader.js';
import type { ConsoleLevel } from './installConsole.js';
import { quickJsVmErrorCodec } from './quickJsVmError.js';

/** The page's first message to the worker, which transfers both ports. */
export type WorkerPortsMessage = {
  version: typeof WORKER_PORTS_VERSION;
  /** The port the schema's transport runs on. */
  control: MessagePort;
  /** The worker's end of the byte wire. */
  wire: MessagePort;
};

const WORKER_PORTS_VERSION = 1;

const filesCodec = enhanceCodec(
  Vector(Tuple(str, Bytes())),
  (files: ModuleFiles) => [...files],
  (entries): ModuleFiles => new Map(entries),
);

const consoleLevelCodec = enhanceCodec(
  Enum({ debug: _void, log: _void, info: _void, warn: _void, error: _void }),
  (level: ConsoleLevel) => ({ tag: level, value: undefined }),
  ({ tag }): ConsoleLevel => tag,
);

const outputCodec = Enum({
  console: Struct({ level: consoleLevelCodec, message: str }),
  fault: quickJsVmErrorCodec,
});

/** One thing the VM tells the page outside its run: a console call, or what went wrong in the VM or its worker. */
export type VmOutput = CodecType<typeof outputCodec>;

export const quickJsWorkerSchema = defineSchema({
  version: 1,
  hello: _void,
  sections: {
    vm: {
      output: subscription({ start: _void, receive: outputCodec }),
      // Answered once the entrypoint's run ends, with the VM's error when it fails.
      start: request({
        request: Struct({ files: filesCodec, entrypoint: str }),
        response: _void,
        error: quickJsVmErrorCodec,
      }),
    },
    fetch: {
      // A host as a URL names it, with its port when the URL has one.
      isHostAllowed: request({ request: str, response: bool }),
    },
  },
});

/** The page's first message to the worker, built from the ports it transfers. */
export function createWorkerPortsMessage(ports: Pick<WorkerPortsMessage, 'control' | 'wire'>): WorkerPortsMessage {
  return { version: WORKER_PORTS_VERSION, ...ports };
}

/**
 * The ports of the page's first message.
 *
 * Throws when the message has another version or shape.
 */
export function parseWorkerPortsMessage(data: unknown): WorkerPortsMessage {
  if (!isRecord(data)) {
    throw new Error(`The QuickJS worker got a first message that is not an object: ${String(data)}`);
  }
  if (data['version'] !== WORKER_PORTS_VERSION) {
    throw new Error(`The QuickJS worker got a first message of unknown version ${String(data['version'])}`);
  }
  const { control, wire } = data;
  if (!(control instanceof MessagePort) || !(wire instanceof MessagePort)) {
    throw new Error('The QuickJS worker got a first message without its two ports');
  }
  return { version: WORKER_PORTS_VERSION, control, wire };
}
