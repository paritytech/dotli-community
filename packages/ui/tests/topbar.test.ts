import { beforeEach, describe, expect, it, vi } from "vitest";

function installTopbarDom(): void {
  document.body.innerHTML = `
    <a id="topbar-home"></a>
    <button id="auth-button"></button>
    <div id="auth-modal-backdrop">
      <div id="auth-modal-title"></div>
      <div id="auth-modal-qr"></div>
      <div id="auth-modal-reason"></div>
      <button id="auth-modal-close"></button>
    </div>
    <div id="user-popover">
      <span id="user-popover-username"></span>
      <button id="user-popover-disconnect"></button>
    </div>
    <button id="theme-toggle"></button>
    <span id="theme-icon-sun"></span>
    <span id="theme-icon-moon"></span>
    <button id="mode-button"></button>
    <div id="mode-popover"><div id="mode-popover-content"></div></div>
    <div id="mode-popover-backdrop"></div>
    <button id="permissions-button"></button>
    <div id="permissions-popover"><div id="permissions-popover-list"></div></div>
    <div id="permissions-popover-backdrop"></div>
  `;
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  document.body.innerHTML = "";
});

describe("topbar disconnect", () => {
  it("emits the Rust-core disconnect request", async () => {
    const { requestTruapiDisconnect } = await import("@dotli/ui/topbar");
    let requests = 0;
    window.addEventListener(
      "dotli:truapi-disconnect-request",
      () => {
        requests += 1;
      },
      { once: true },
    );

    requestTruapiDisconnect();

    expect(requests).toBe(1);
  });

  it("routes the disconnect button through the Rust-core event path", async () => {
    installTopbarDom();
    const { initTopBar } = await import("@dotli/ui/topbar");
    let requests = 0;
    window.addEventListener("dotli:truapi-disconnect-request", () => {
      requests += 1;
    });

    initTopBar();
    window.dispatchEvent(
      new CustomEvent("dotli:truapi-session-state", {
        detail: { connected: true },
      }),
    );

    document.getElementById("auth-button")?.click();
    expect(
      document.getElementById("user-popover")?.classList.contains("open"),
    ).toBe(true);

    document.getElementById("user-popover-disconnect")?.click();

    expect(requests).toBe(1);
    expect(
      document.getElementById("user-popover")?.classList.contains("open"),
    ).toBe(false);
  });
});

describe("settings dependency list", () => {
  it("lists current runtime packages without Novasama dependencies", async () => {
    installTopbarDom();
    vi.stubGlobal("__DOTLI_VERSION__", "0.5.0");
    vi.stubGlobal("__SMOLDOT_VERSION__", "3.2.0");
    vi.stubGlobal("__SMOLDOT_COMMIT__", "abcdef1234567890");
    vi.stubGlobal("__POLKADOT_API_VERSION__", "2.1.6");
    vi.stubGlobal("__POLKADOT_API_VERSIONS__", [
      { name: "@polkadot-api/json-rpc-provider", version: "0.2.0" },
    ]);
    vi.stubGlobal("__PARITY_TRUAPI_VERSIONS__", [
      { name: "@parity/truapi", version: "0.3.0" },
      { name: "@parity/truapi-host-wasm", version: "0.1.0" },
    ]);

    const opened: string[] = [];
    vi.spyOn(window, "open").mockImplementation((url?: string | URL) => {
      opened.push(String(url));
      return null;
    });

    const { initTopBar } = await import("@dotli/ui/topbar");
    initTopBar();

    document.getElementById("mode-button")?.click();

    const content = document.getElementById("mode-popover-content");
    expect(content?.textContent).toContain("@parity/truapi");
    expect(content?.textContent).toContain("@parity/truapi-host-wasm");
    expect(content?.textContent).not.toContain("@novasamatech");

    Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent === "Share diagnostic")
      ?.click();

    expect(opened).toHaveLength(1);
    const body = new URL(opened[0]!).searchParams.get("body") ?? "";
    expect(body).toContain("@parity/truapi");
    expect(body).toContain("@parity/truapi-host-wasm");
    expect(body).not.toContain("@novasamatech");
  });
});
