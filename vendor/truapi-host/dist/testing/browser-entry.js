// Entry point of the bundle the test host server serves.
//
// Reads what to run from the page URL rather than from a generated script, so
// the server can bundle once and serve every test: the fixture varies the
// query string, not the bundle.
import { startTestHost } from "./host-page.js";
const params = new URLSearchParams(window.location.search);
const productUrl = params.get("product");
const rawMock = params.get("mock");
if (!productUrl) {
    throw new Error("test host page needs a ?product= URL; the Playwright fixture sets it");
}
const container = document.getElementById("product-container");
if (!container) {
    throw new Error("test host page is missing its #product-container element");
}
// `name` for a built-in, `name:<64 hex>` when the test supplied entropy.
const accounts = params
    .get("accounts")
    ?.split(",")
    .filter(Boolean)
    .map((entry) => {
    const separator = entry.indexOf(":");
    if (separator === -1)
        return entry;
    const name = entry.slice(0, separator);
    const hex = entry.slice(separator + 1);
    const bytes = hex.match(/../g) ?? [];
    return { name, entropy: Uint8Array.from(bytes.map((b) => parseInt(b, 16))) };
});
const login = params.get("login");
const productId = params.get("productId") ?? undefined;
const rawRuntimeConfig = params.get("runtimeConfig");
const topology = params.get("topology");
const allowances = params.get("allowances");
const logLevel = params.get("logLevel") ?? undefined;
void startTestHost({
    productUrl,
    container,
    mock: rawMock ? JSON.parse(rawMock) : undefined,
    runtimeConfig: {
        ...(rawRuntimeConfig
            ? JSON.parse(rawRuntimeConfig)
            : {}),
        ...(productId ? { productId } : {}),
    },
    accounts: accounts,
    loginBehavior: login === "manual" ? "manual" : "auto",
    topology: topology === "main-thread" ? "main-thread" : "worker",
    allowances: allowances === "chain" ? "chain" : "granted",
    logLevel,
}).catch((error) => {
    // Surface boot failures in the page rather than only the console: a fixture
    // that times out waiting for the control surface should be able to read why.
    const message = error instanceof Error ? error.message : String(error);
    const banner = document.createElement("pre");
    banner.id = "test-host-error";
    banner.textContent = `test host failed to start: ${message}`;
    document.body.append(banner);
    throw error;
});
