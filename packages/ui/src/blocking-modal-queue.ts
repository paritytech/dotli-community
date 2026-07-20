// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

type BlockingModalTask<T> = (signal: AbortSignal) => Promise<T> | T;

interface QueueEntry {
  readonly scope: BlockingModalScopeImpl;
  readonly controller: AbortController;
  readonly task: BlockingModalTask<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  settled: boolean;
}

export interface BlockingModalScope {
  enqueue<T>(task: BlockingModalTask<T>): Promise<T>;
  dispose(reason?: string): void;
}

export interface BlockingModalCoordinator {
  createScope(): BlockingModalScope;
}

export function blockingModalAbortError(reason?: unknown): DOMException {
  if (reason instanceof DOMException && reason.name === "AbortError") {
    return reason;
  }
  return new DOMException(
    typeof reason === "string" ? reason : "Blocking modal scope disposed",
    "AbortError",
  );
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw blockingModalAbortError(signal.reason);
  }
}

class BlockingModalCoordinatorImpl implements BlockingModalCoordinator {
  readonly queue: QueueEntry[] = [];
  active: QueueEntry | null = null;

  createScope(): BlockingModalScope {
    return new BlockingModalScopeImpl(this);
  }

  enqueue<T>(
    scope: BlockingModalScopeImpl,
    task: BlockingModalTask<T>,
  ): Promise<T> {
    if (scope.disposed) {
      return Promise.reject(blockingModalAbortError(scope.disposeReason));
    }

    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        scope,
        controller: new AbortController(),
        task,
        resolve: (value) => {
          resolve(value as T);
        },
        reject,
        settled: false,
      });
      this.drain();
    });
  }

  disposeScope(scope: BlockingModalScopeImpl): void {
    const reason = blockingModalAbortError(scope.disposeReason);
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const entry = this.queue[index];
      if (entry.scope !== scope) {
        continue;
      }
      this.queue.splice(index, 1);
      entry.controller.abort(reason);
      entry.settled = true;
      entry.reject(reason);
    }

    if (this.active?.scope === scope) {
      this.active.controller.abort(reason);
    }
  }

  private drain(): void {
    if (this.active !== null) {
      return;
    }
    const entry = this.queue.shift();
    if (entry === undefined) {
      this.emitActiveChanged(false);
      return;
    }

    this.active = entry;
    this.emitActiveChanged(true);
    if (entry.controller.signal.aborted) {
      this.finish(entry, {
        ok: false,
        error: blockingModalAbortError(entry.controller.signal.reason),
      });
      return;
    }

    let result: unknown;
    try {
      result = entry.task(entry.controller.signal);
    } catch (error) {
      this.finish(entry, { ok: false, error });
      return;
    }
    if (entry.scope.disposed) {
      this.finish(entry, {
        ok: false,
        error: blockingModalAbortError(entry.controller.signal.reason),
      });
      return;
    }

    entry.controller.signal.addEventListener(
      "abort",
      () => {
        this.finish(entry, {
          ok: false,
          error: blockingModalAbortError(entry.controller.signal.reason),
        });
      },
      { once: true },
    );
    void Promise.resolve(result).then(
      (value) => {
        this.finish(entry, { ok: true, value });
      },
      (error: unknown) => {
        this.finish(entry, { ok: false, error });
      },
    );
  }

  private finish(
    entry: QueueEntry,
    result: { ok: true; value: unknown } | { ok: false; error: unknown },
  ): void {
    if (entry.settled) {
      return;
    }
    entry.settled = true;
    if (result.ok) {
      entry.resolve(result.value);
    } else {
      entry.reject(result.error);
    }
    if (this.active === entry) {
      this.active = null;
      this.drain();
    }
  }

  private emitActiveChanged(active: boolean): void {
    window.dispatchEvent(
      new CustomEvent("dotli:blocking-modal-active", {
        detail: { active },
      }),
    );
  }
}

class BlockingModalScopeImpl implements BlockingModalScope {
  private readonly coordinator: BlockingModalCoordinatorImpl;
  disposed = false;
  disposeReason: string | undefined;

  constructor(coordinator: BlockingModalCoordinatorImpl) {
    this.coordinator = coordinator;
  }

  enqueue<T>(task: BlockingModalTask<T>): Promise<T> {
    return this.coordinator.enqueue(this, task);
  }

  dispose(reason = "TrUAPI host disposed"): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.disposeReason = reason;
    this.coordinator.disposeScope(this);
  }
}

export function createBlockingModalCoordinator(): BlockingModalCoordinator {
  return new BlockingModalCoordinatorImpl();
}

export function createBlockingModalScope(
  coordinator: BlockingModalCoordinator = createBlockingModalCoordinator(),
): BlockingModalScope {
  return coordinator.createScope();
}
