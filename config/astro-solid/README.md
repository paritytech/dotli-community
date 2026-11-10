# `@config/astro-solid`

## Overview

An Astro integration for Solid 2. Renders Solid components on the server and hydrates them in islands.

## Responsibilities

- **Owns:**
  - the Astro renderer
  - the integration that adds it
  - passing the client asset manifest to server renders, so `lazy()` inside islands resolves
- **Does not own:** the components and islands.

## Public API

| Entry                           | Use                                                    |
| ------------------------------- | ------------------------------------------------------ |
| `@config/astro-solid`           | Default export `astroSolid(options)`, the integration. |
| `@config/astro-solid/client.js` | The client entrypoint for islands.                     |
| `@config/astro-solid/server.js` | The server entrypoint for rendering.                   |

An Astro app adds the integration to its Astro config.

## Design

- **Setup:** adds the renderer and the Solid Vite plugin with SSR. Solid libraries are `noExternal`, so Node never loads
  their browser build.
- **Manifest:** `virtual:astro-solid-manifest` serves the live manifest in dev, and the client build's manifest in a
  build.
- **Server:** streams a component, with hydration markers unless the island has no directive.
- **Client:** hydrates, or renders for `client:only`. Props live in a signal, so a re-render updates the island.
- **No build step:** Node loads it straight from the Astro config.
