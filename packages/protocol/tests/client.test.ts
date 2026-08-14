// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Behaviour of the time limit a protocol request promises its caller.
 *
 * The client owns module-level singleton state (the frame, the cached frame
 * promises, the ready flag), so every scenario drives a stub element through
 * `document.createElement` and tears the state down afterwards. A real
 * happy-dom iframe would navigate to the protocol origin, fail that fetch, and
 * dispatch its own error event before a scenario could drive it.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { SITE_ID } from "@dotli/config/config";
import { getActiveSupportedGenesisHashes } from "@dotli/config/network";
import { SHARED_CORE_SESSION_KEY } from "@dotli/protocol/auth-storage";
import {
  createRemoteChainProvider,
  getProtocolOrigin,
  readSharedAuthStorage,
  readSharedModeStorage,
  resetProtocolFrame,
  resolveDotNameRemote,
  resolveOwnerRemote,
  warmupProtocol,
} from "@dotli/protocol/client";
import { ProtocolRequestTimeoutError } from "@dotli/protocol/errors";

/** The stub element the client last asked `document.createElement` for. */
let frame: HTMLElement;
let framePostMessage: Mock;

/** Deliver a protocol envelope as if the frame had posted it. */
function dispatchFromFrame(data: unknown): void {
  const holder = frame as unknown as { contentWindow: unknown };
  window.dispatchEvent(
    new MessageEvent("message", {
      data,
      origin: getProtocolOrigin(),
      // The client only accepts envelopes whose source is the frame's own
      // window object, so the stub window must be passed through by identity.
      source: holder.contentWindow as Window,
    }),
  );
}

/**
 * Report whether a promise has settled, without adopting its result.
 *
 * The handler attached here keeps a deliberately abandoned request from
 * surfacing as an unhandled rejection when the teardown rejects it.
 */
function settleTracker(promise: Promise<unknown>): () => boolean {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return () => settled;
}

/** Drain the microtask queue so the client's awaits advance under fake timers. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  framePostMessage = vi.fn();
  const realCreateElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tagName: string) => {
    if (tagName !== "iframe") {
      return realCreateElement(tagName);
    }
    // A real happy-dom iframe navigates to the protocol origin on append and
    // dispatches its own error event when that fetch fails. A div carries
    // every member the frame builder touches and never hits the network.
    const element = realCreateElement("div");
    Object.defineProperty(element, "contentWindow", {
      configurable: true,
      value: { postMessage: framePostMessage },
    });
    frame = element;
    return element;
  });
});

afterEach(() => {
  resetProtocolFrame();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("Keeping a protocol request inside the time limit it promises", () => {
  const slowFrameCases = [
    {
      request: "a name lookup",
      frame: "opens but never reports itself ready",
      limitMs: 90_000,
      opensAfterMs: 0,
      blamedWait: "ready",
      calledMethod: "resolveDotName",
      call: () => resolveDotNameRemote("alice"),
    },
    {
      request: "a saved session read",
      frame: "takes twenty seconds to open and then never answers",
      limitMs: 30_000,
      opensAfterMs: 20_000,
      blamedWait: "reply",
      calledMethod: "authStorageRead",
      call: () => readSharedAuthStorage(SITE_ID, SHARED_CORE_SESSION_KEY),
    },
    {
      request: "a saved session read",
      frame: "never opens at all",
      limitMs: 30_000,
      opensAfterMs: null,
      blamedWait: "load",
      calledMethod: "authStorageRead",
      call: () => readSharedAuthStorage(SITE_ID, SHARED_CORE_SESSION_KEY),
    },
  ];

  it.each(slowFrameCases)(
    "As someone making $request, I wait no longer than the limit I was promised when the shared frame $frame, and I am told which wait spent it",
    async ({ limitMs, opensAfterMs, blamedWait, calledMethod, call }) => {
      // Given a shared frame that is slow in the way this example describes
      const pending = call();
      const settled = settleTracker(pending);
      await flush();
      if (opensAfterMs !== null) {
        await vi.advanceTimersByTimeAsync(opensAfterMs);
        frame.dispatchEvent(new Event("load"));
        await flush();
      }

      // When the promised limit has all but elapsed
      const alreadyElapsed = opensAfterMs ?? 0;
      await vi.advanceTimersByTimeAsync(limitMs - alreadyElapsed - 1);
      expect(settled()).toBe(false);

      // Then the last millisecond of the limit ends the wait, naming the
      // wait that consumed it
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).rejects.toBeInstanceOf(ProtocolRequestTimeoutError);
      await expect(pending).rejects.toMatchObject({
        method: calledMethod,
        timeoutMs: limitMs,
        phase: blamedWait,
      });
    },
  );

  it("As someone making an owner lookup, I am told the shared frame failed to open rather than being told my own time ran out", async () => {
    // Given an owner lookup, which is promised more time than opening the
    // shared frame is allowed to take
    const pending = resolveOwnerRemote("alice");
    const settled = settleTracker(pending);
    await flush();

    // When the frame never opens and its own allowance runs out
    await vi.advanceTimersByTimeAsync(30_000);

    // Then the more specific failure is the one reported
    expect(settled()).toBe(true);
    await expect(pending).rejects.toThrow(
      "Shared host iframe timed out while loading",
    );
    await expect(pending).rejects.not.toBeInstanceOf(
      ProtocolRequestTimeoutError,
    );
  });

  it("As someone making a name lookup, I am told the shared frame was torn down rather than being told my own time ran out", async () => {
    // Given a name lookup waiting on a frame that has opened but is not ready
    const pending = resolveDotNameRemote("alice");
    const settleTrackerFor = settleTracker(pending);
    await flush();
    frame.dispatchEvent(new Event("load"));
    await flush();

    // When the frame is torn down long before the promised limit
    await vi.advanceTimersByTimeAsync(10_000);
    resetProtocolFrame();
    await flush();

    // Then the teardown is the reported reason
    expect(settleTrackerFor()).toBe(true);
    await expect(pending).rejects.toThrow(
      "Protocol frame state reset before ready signal",
    );
    await expect(pending).rejects.not.toBeInstanceOf(
      ProtocolRequestTimeoutError,
    );
  });

  it("As someone warming the protocol up, I am never cut off, because warming up waits on chain sync", async () => {
    // Given a warm-up against a frame that has opened but is not ready
    const pending = warmupProtocol();
    const settled = settleTracker(pending);
    await flush();
    frame.dispatchEvent(new Event("load"));
    await flush();

    // When the whole allowance for becoming ready goes by, one millisecond
    // short of its end
    await vi.advanceTimersByTimeAsync(239_999);

    // Then the warm-up is still waiting
    expect(settled()).toBe(false);

    // And when that allowance runs out, becoming ready is the reported
    // reason, never a limit of the warm-up's own
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).rejects.toThrow(
      "Shared protocol iframe timed out (no ready signal)",
    );
    await expect(pending).rejects.not.toBeInstanceOf(
      ProtocolRequestTimeoutError,
    );
  });

  it("As someone whose light client crashes mid-request, I am told it crashed rather than being told my own time ran out", async () => {
    // Given a name lookup that has reached a ready frame
    const pending = resolveDotNameRemote("alice");
    const settled = settleTracker(pending);
    await flush();
    frame.dispatchEvent(new Event("load"));
    await flush();
    dispatchFromFrame({ namespace: "dotli:protocol", kind: "ready" });
    await flush();

    // When the light client crashes well inside the promised limit
    await vi.advanceTimersByTimeAsync(10_000);
    dispatchFromFrame({
      namespace: "dotli:protocol",
      kind: "fatal",
      message: "smoldot panicked",
    });
    await flush();

    // Then the crash is the reported reason
    expect(settled()).toBe(true);
    await expect(pending).rejects.toThrow("smoldot panicked");
    await expect(pending).rejects.not.toBeInstanceOf(
      ProtocolRequestTimeoutError,
    );
  });

  it("As someone whose reply never came, I stop hearing progress for that request once my time has run out", async () => {
    // Given a name lookup on a ready frame, reporting progress as it goes
    const progress = vi.fn();
    const pending = resolveDotNameRemote("alice", progress);
    const settled = settleTracker(pending);
    await flush();
    frame.dispatchEvent(new Event("load"));
    await flush();
    dispatchFromFrame({ namespace: "dotli:protocol", kind: "ready" });
    await flush();
    const request = framePostMessage.mock.calls.at(-1)?.[0] as { id: string };

    // When my time runs out and the frame reports progress afterwards
    await vi.advanceTimersByTimeAsync(90_000);
    expect(settled()).toBe(true);
    await expect(pending).rejects.toBeInstanceOf(ProtocolRequestTimeoutError);
    progress.mockClear();
    dispatchFromFrame({
      namespace: "dotli:protocol",
      kind: "progress",
      id: request.id,
      message: "still working",
    });
    await flush();

    // Then that progress reaches nobody
    expect(progress).not.toHaveBeenCalled();
  });

  it("As someone reading a saved preference from a healthy frame, I get my answer and nothing is left ticking", async () => {
    // Given a healthy shared frame
    const pending = readSharedModeStorage(SITE_ID, "backend");
    await flush();
    frame.dispatchEvent(new Event("load"));
    await flush();

    // When the frame answers
    const request = framePostMessage.mock.calls[0]?.[0] as { id: string };
    dispatchFromFrame({
      namespace: "dotli:protocol",
      kind: "response",
      id: request.id,
      ok: true,
      result: "smoldot-shared-worker",
    });
    await expect(pending).resolves.toBe("smoldot-shared-worker");

    // Then no limit of mine is still counting down, and letting the clock run
    // past where it would have expired changes nothing
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(pending).resolves.toBe("smoldot-shared-worker");
  });

  it("As a dApp opening a chain connection while the frame is still starting up, I am told the connection failed inside the time a connection is promised", async () => {
    // Given a chain the active backend serves, and a frame that opens but
    // never reports itself ready
    const [genesisHash] = [...getActiveSupportedGenesisHashes()];
    expect(genesisHash).toBeDefined();
    const replies: unknown[] = [];
    const connect = createRemoteChainProvider(genesisHash as string);
    const connection = connect?.((message) => {
      replies.push(message);
    });
    await flush();
    frame.dispatchEvent(new Event("load"));
    await flush();

    // When I ask for a block and the connection's own allowance runs out
    connection?.send({ jsonrpc: "2.0", id: 7, method: "chain_getBlock" });
    await vi.advanceTimersByTimeAsync(30_000);
    await flush();

    // Then I have my error, long before the frame gives up on becoming ready
    expect(replies).toEqual([
      {
        jsonrpc: "2.0",
        id: 7,
        error: { code: -32603, message: expect.stringContaining("timed out") },
      },
    ]);
  });

});
