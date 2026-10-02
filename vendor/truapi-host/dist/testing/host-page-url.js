/** Apply `config` to a host page URL, returning the configured URL. */
export function hostPageUrl(base, config) {
    const url = new URL(base);
    url.searchParams.set("product", config.productUrl);
    if (config.mock)
        url.searchParams.set("mock", JSON.stringify(config.mock));
    if (config.productId)
        url.searchParams.set("productId", config.productId);
    if (config.runtimeConfig) {
        url.searchParams.set("runtimeConfig", JSON.stringify(config.runtimeConfig));
    }
    if (config.accounts) {
        // `name` for a built-in, `name:<64 hex>` when the test supplies entropy.
        url.searchParams.set("accounts", config.accounts
            .map((account) => typeof account === "string"
            ? account
            : `${account.name}:${[...account.entropy]
                .map((byte) => byte.toString(16).padStart(2, "0"))
                .join("")}`)
            .join(","));
    }
    if (config.loginBehavior)
        url.searchParams.set("login", config.loginBehavior);
    if (config.topology)
        url.searchParams.set("topology", config.topology);
    if (config.allowances)
        url.searchParams.set("allowances", config.allowances);
    if (config.logLevel)
        url.searchParams.set("logLevel", config.logLevel);
    return url.toString();
}
