# `@config/vite`

Build plugins and options shared by the host, sandbox and protocol builds, plus the tests' CSS-modules naming.

## Responsibility

- Hold the Vite and Astro plugins that more than one app uses, or that are too large to live in an app config.
- Not an app's own config: ports, plugin order and `define` stay in each app. What every app's build shares is one
  preset.

## Design

- Each plugin or option set is its own export entry. The package has no side effects.
- Entries run in Node and are type-checked without emitting.
- Build-time rules live here as code, such as the inline-script check that fails the build when a script's text would
  end its tag early.
- One serving table holds the routes and headers of every local server. Its spec reads the header values of nginx's
  snippets back against it, so a header value cannot drift from nginx unnoticed. Which snippet each nginx location
  includes is not checked.

## Entry points

Imported by the apps' Vite and Astro configs. Beyond them, the host's Storybook config takes the inline-script entry,
its page head takes the social meta entry, the dev scripts take the mode sync, runtime network config and serving
entries, and the host runtime takes the signing worker entry.

- `./app`: `dotliApp`, the settings every app's build shares (base, env directory, wasm, the Sentry upload), which also
  fills in the commit and a `dotli@semver` Sentry release.
- `./build-options`: `appBuildOptions` and `rolldownOptions`, the shared minify chain (terser then oxc) and tree-shaking
  settings.
- `./css-modules`: CSS-modules options with one short-name counter across every Vite environment of a build.
- `./inline-script`: a `?inline-script` import returns a module bundled into one classic script, as text a response
  writes into a document dotli does not build.
- `./astro-pwa`: an Astro integration that generates the manifest and service worker after the page is written.
- `./service-worker`: builds a hand-written service worker into one file at the root, with the app's own environment.
- `./spa-fallback`: dev middleware that routes page loads as nginx does.
- `./truapi-signing-worker`: a second TrUAPI worker on the `testing` wasm bundle, which has a signing host.
- `./mode-sync`: in-memory mode preference sync on the protocol origin for local servers.
- `./runtime-network-config`: serves `/dotli-network.js` from `$DOTLI_NETWORK` on opt-in.
- `./serving`: the route and header table of the release, test and dev servers.
- `./dependency-versions`: the installed version of each direct workspace dependency in a scope, for the diagnostics
  panel.
- `./build-info`: writes the build version file and reads the release version.
- `./social-meta`: link-unfurl meta tags with an absolute image URL.
