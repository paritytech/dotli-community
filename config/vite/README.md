# `@config/vite`

Build plugins and options shared by the host, sandbox and protocol builds, plus the tests' CSS-modules naming.

## Responsibility

- Hold the Vite and Astro plugins that more than one app uses, or that are too large to live in an app config.
- Not an app's own config: each app merges its port, its own plugins and its own `define` values over the shared preset.

## Design

- Each plugin or option set an app or tool imports is its own export entry. What only the preset uses stays internal.
  The package has no side effects.
- Entries run in Node and are type-checked without emitting.
- Build-time rules live here as code, such as the inline-script check that fails the build when a script's text would
  end its tag early.
- One serving table holds the routes and headers of every local server. It also picks the file that answers a path, in
  nginx's order, so the release and test servers agree. Its spec reads the header values of nginx's snippets back
  against it, so a header value cannot drift from nginx unnoticed. Which snippet each nginx location includes is not
  checked.
- The runtime network config script has one owner for its path, headers and body. Every local server sends it with the
  container's headers, same-origin only, and reads `$DOTLI_NETWORK` once at start, so a value that is not JSON stops the
  server there. Its spec holds the headers to the container's nginx snippet.

## Entry points

Imported by the apps' Vite and Astro configs. Beyond them, test and Storybook configs take the test-defines and
inline-script entries, a page head takes the social meta entry, the dev scripts take the mode sync, runtime network
config and serving entries, and an app runtime takes the signing worker entry.

- `./app`: `dotliApp`, which returns each app's Vite config: the shared preset (env directory, wasm, the runtime network
  config, the build info, the dev isolation headers, CSS modules, the worker and build options, and the compile-time
  values that strip the Sentry SDK's debug logger) with the app's own merged over it and the Sentry upload last. Making
  it fills in the commit and a `dotli@semver` Sentry release.
- `./css-modules`: CSS-modules options with one short-name counter across every Vite environment of a build.
- `./inline-script`: a `?inline-script` import returns a module bundled into one classic script, as text a response
  writes into a document dotli does not build.
- `./astro-pwa`: an Astro integration that generates the manifest and service worker after the page is written.
- `./service-worker`: builds a hand-written service worker into one file at the root, with the app's own environment.
- `./spa-fallback`: dev middleware that routes page loads as nginx does and answers a malformed escape with 404, and the
  decision it makes for each request.
- `./truapi-signing-worker`: a second TrUAPI worker on the `testing` wasm bundle, which has a signing host.
- `./mode-sync`: in-memory mode preference sync on the protocol origin for local servers.
- `./runtime-network-config`: the `/dotli-network.js` script, its path, its same-origin headers and its body from
  `$DOTLI_NETWORK`, for the release and test servers, and the plugin that injects and serves it on opt-in.
- `./serving`: the route, file and header table of the release, test and dev servers, and the dev servers' isolation
  headers.
- `./dependency-versions`: the installed version of each direct workspace dependency in a scope, for the diagnostics
  panel.
- `./build-info`: writes the build version file and reads the release version.
- `./social-meta`: link-unfurl meta tags with an absolute image URL.
- `./test-defines`: the build-time values every test and story build defines, the enabled networks.
