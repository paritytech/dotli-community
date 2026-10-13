# `@dotli/sandbox-checker`

A checker build of the sandbox wraps the browser APIs that a product should reach only through the host. This package
holds the checker script and the function that injects it into a product's HTML.

## Responsibility

- The checker: it reports each use of a wrapped API to the host page and lets the call run.
- Injecting the checker first in the product's `<head>`.
- Not the violation panel that lists reports. That lives in the host app.

## Design

- The checker installs wrappers on a page and reports each use to the parent as a `DOTLI_API_VIOLATION` message. It
  imports nothing, because the product's HTML inlines it as a bundled script. Wallet globals count only after a short
  delay, since extensions write them while they start.
- The build bundles the checker into one string through the shared Vite tooling's `?inline-script` suffix.
- The injector builds the `<script>` tag and puts it before everything else in `<head>`, or before the whole document
  when there is no head. It is safe for scripts that contain `$`.
- The injector loads as its own chunk, so a normal build never loads it.
- A failed report never fails the product's call.

## Public API

### `@dotli/sandbox-checker`

- `loadSandboxChecker`: lazy loader for the injector module.
- `injectSandboxChecker(html)`: returns the HTML with the checker script first. The app's service worker builds as one
  file, so it imports this directly.
