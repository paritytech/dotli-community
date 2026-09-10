// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

const MAX_INPUT_BYTES = 1024 * 1024;
const TOKEN = /^[a-z0-9](?:[a-z0-9+._-]*[a-z0-9])?$/;

export const MEDIATED_INPUT_STATUS = Object.freeze({
  ready: 3,
  cancelled: 4,
  permissionDenied: 5,
  failed: 6,
} as const);

export interface MediatedInputRequest {
  handle: number;
  kind: "camera-ur";
  mediaType: string;
  maxBytes: number;
}

export interface MediatedInputHostDependencies {
  authorize(label: string, signal: AbortSignal): Promise<boolean>;
  scan(
    label: string,
    request: Readonly<MediatedInputRequest>,
    signal: AbortSignal,
  ): Promise<Uint8Array>;
  send(owner: object, handle: number, status: number, bytes?: Uint8Array): void;
  isCancellation(error: unknown): boolean;
  isPermissionDenied(error: unknown): boolean;
}

interface ActiveMediatedInput {
  owner: object;
  request: MediatedInputRequest;
  controller: AbortController;
  suppressResult: boolean;
}

export function validatedMediatedInputRequest(
  value: unknown,
): MediatedInputRequest | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const request = value as Record<string, unknown>;
  if (
    !Object.keys(request).every((key) =>
      ["type", "handle", "kind", "mediaType", "maxBytes"].includes(key),
    ) ||
    request.type !== "dotli:polkavm-mediated-input-request" ||
    !Number.isInteger(request.handle) ||
    Number(request.handle) < 1 ||
    Number(request.handle) > 0xffffffff ||
    request.kind !== "camera-ur" ||
    typeof request.mediaType !== "string" ||
    request.mediaType.length > 64 ||
    !TOKEN.test(request.mediaType) ||
    !Number.isInteger(request.maxBytes) ||
    Number(request.maxBytes) < 1 ||
    Number(request.maxBytes) > MAX_INPUT_BYTES
  ) {
    return null;
  }
  return {
    handle: Number(request.handle),
    kind: "camera-ur",
    mediaType: request.mediaType,
    maxBytes: Number(request.maxBytes),
  };
}

export class MediatedInputHost {
  readonly #dependencies: MediatedInputHostDependencies;
  #active: ActiveMediatedInput | undefined;

  constructor(dependencies: MediatedInputHostDependencies) {
    this.#dependencies = dependencies;
  }

  request(owner: object, label: string, request: MediatedInputRequest): void {
    if (this.#active !== undefined) {
      this.#dependencies.send(
        owner,
        request.handle,
        MEDIATED_INPUT_STATUS.failed,
      );
      return;
    }
    const active = {
      owner,
      request,
      controller: new AbortController(),
      suppressResult: false,
    };
    this.#active = active;
    void this.#run(label, active);
  }

  cancel(owner: object, handle: number): void {
    const active = this.#active;
    if (active?.owner !== owner || active.request.handle !== handle) {
      return;
    }
    active.suppressResult = true;
    active.controller.abort("guest cancelled mediated input");
  }

  stop(): void {
    const active = this.#active;
    if (active === undefined) {
      return;
    }
    active.suppressResult = true;
    active.controller.abort("mediated input host stopped");
  }

  async #run(label: string, active: ActiveMediatedInput): Promise<void> {
    try {
      if (
        !(await this.#dependencies.authorize(label, active.controller.signal))
      ) {
        this.#sendIfCurrent(active, MEDIATED_INPUT_STATUS.permissionDenied);
        return;
      }
      if (active.controller.signal.aborted) {
        return;
      }
      const bytes = await this.#dependencies.scan(
        label,
        active.request,
        active.controller.signal,
      );
      if (
        !bytes.byteLength ||
        bytes.byteLength > active.request.maxBytes ||
        bytes.byteLength > MAX_INPUT_BYTES
      ) {
        throw new Error("mediated input result exceeds its registered bound");
      }
      this.#sendIfCurrent(active, MEDIATED_INPUT_STATUS.ready, bytes);
    } catch (error) {
      if (!active.suppressResult) {
        const status = this.#dependencies.isCancellation(error)
          ? MEDIATED_INPUT_STATUS.cancelled
          : this.#dependencies.isPermissionDenied(error)
            ? MEDIATED_INPUT_STATUS.permissionDenied
            : MEDIATED_INPUT_STATUS.failed;
        this.#sendIfCurrent(active, status);
      }
    } finally {
      if (this.#active === active) {
        this.#active = undefined;
      }
    }
  }

  #sendIfCurrent(
    active: ActiveMediatedInput,
    status: number,
    bytes?: Uint8Array,
  ): void {
    if (this.#active !== active || active.suppressResult) {
      return;
    }
    this.#dependencies.send(active.owner, active.request.handle, status, bytes);
  }
}
