# `@config/vite`

## Overview

Build plugins and options shared by these builds:

- host
- sandbox
- protocol

## Responsibilities

- **Owns:** Vite and Astro plugins that several apps use, or that are too large for an app config.
- **Does not own:** an app's own config. Each app merges its port, plugins and `define` values over the shared preset.

## Public API

| Entry                      | What it does                                                                   |
| -------------------------- | ------------------------------------------------------------------------------ |
| `./app`                    | `createDotliApp({ appDir, site, roots })`. See below.                          |
| `./css-modules`            | CSS-modules options with one short-name counter per build.                     |
| `./inline-script`          | A `?inline-script` import returns a module bundled into one classic script.    |
| `./astro-pwa`              | Astro integration for the web manifest and service worker.                     |
| `./astro-modulepreload`    | Astro integration that preloads the modules each page runs at load.            |
| `./page-modules`           | Reads a built page's entries, modulepreloads and load island modules.          |
| `./service-worker`         | Builds a hand-written service worker into one file at the root.                |
| `./truapi-signing-worker`  | A second TrUAPI worker on the `testing` wasm bundle, with a signing host.      |
| `./build-info`             | Writes the build version file and reads the release version.                   |
| `./dependency-versions`    | Installed versions of direct workspace dependencies, for diagnostics.          |
| `./social-meta`            | Link-unfurl meta tags with an absolute image URL.                              |
| `./test-defines`           | Build-time values for tests and stories: the enabled networks.                 |
| `./serving`                | The route, file and header table. The release, test and dev servers read it.   |
| `./spa-fallback`           | Dev middleware that routes page loads and answers a malformed escape with 404. |
| `./runtime-network-config` | The `/dotli-network.js` script from `$DOTLI_NETWORK`, and its plugin.          |
| `./mode-sync`              | In-memory mode preference sync on the protocol origin, for local servers.      |

**`./app`:** `createDotliApp` returns `createViteConfig(own)` and the serving table built from `roots`.

- The config starts from the shared preset and puts the app's own config over it. The Sentry upload comes last.
- The preset covers:
  - env
  - wasm
  - the runtime network config
  - build info
  - dev isolation headers
  - a locally trusted dev certificate (not for preview)
  - CSS modules
  - worker and build options
  - stripping the Sentry debug logger
- It sets the commit and a `dotli@semver` Sentry release.

**`./serving`:** `createLocalServing(roots)` builds everything that depends on the roots once. What reads no roots is a
plain export.

## Design

- **One entry per import:** each plugin an app or tool imports is its own export. The rest stays internal.
- **Node only:** entries run in Node, type-checked without emitting.
- **Serving table:** one table holds the routes and headers of every local server.
  - Each server hands in its local roots once. Routes, headers, certificate and allowed hosts all follow them.
  - Under a local root, a subdomain is a product's shell. `app.` is the sandbox, and the root is the bare host.
  - Files resolve in nginx's order, so the release and test servers agree.
  - A spec checks header values against nginx's snippets. Which snippet each location includes is not checked.
- **Module preload:** Astro writes no modulepreload links, so the integration adds them once the pages are built.
  - Each page's head gets one link for every module the page runs at load. Those are its entry scripts and the islands
    that hydrate at load, with their static imports.
  - The client bundle's import graph names the imports. Dynamic imports and later islands get no link.
  - A page reference the graph does not hold fails the build, naming the page and the reference.
  - One reader knows Astro's island attributes, and the eager path check reads pages through it too. An island that
    hydrates at load with no component fails the read, naming the page and the island.
- **Runtime network config:** every local server reads `$DOTLI_NETWORK` once at start. A value that is not JSON stops
  the server.
