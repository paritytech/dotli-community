# Third-Party Notices

dot.li (dotli) is licensed under the GNU Affero General Public License v3.0 (`AGPL-3.0-only`). This product depends on
and, where applicable, bundles the third-party open-source packages listed below, each of which remains under its own
license. Packages are grouped by SPDX license identifier and listed alphabetically. Copyright and permission notices for
each package are retained in its distribution under `node_modules`.

GPL-family components (GPL-3.0 with the Classpath linking exception) are compatible with this project's AGPL-3.0
outbound license. The vendored `@useragent-kit/polkavm-runtime` browser artifacts remain under MPL-2.0. Complete
notices, per-file hashes, and source provenance ship beside the runtime. Build-time-only tooling under source-available
FSL-1.1-MIT terms is not redistributed as part of the application.

The vendored `@parity/truapi` client is MIT-licensed. The `@parity/truapi-host` distribution is `MIT AND AGPL-3.0-only`,
not MIT-only: its Rust signing runtime/WASM includes the native Chat, HOP and Coinage implementations. Both packages
come from
[host-rust-core revision `437a46c5af88b3c4a962d763f8fa5732e9c48183`](https://github.com/paritytech/host-rust-core/commit/437a46c5af88b3c4a962d763f8fa5732e9c48183).
Archive and installed artifact hashes are recorded in `vendor/truapi-host.lock.json`, including the local dependency
override. The Host's `LICENSE`, `LICENSE-AGPL-3.0` and `NOTICE` are retained in `vendor/truapi-host/`; the notice
identifies the adapted components and their source revisions. Corresponding Source for redistribution must include that
exact Host source, its component provenance and build instructions, plus any local modifications; a repository URL alone
does not supply unpublished changes.

> Generated from the resolved dependency tree (841 distinct third-party packages) by `scripts/third-party-notices.ts`.
> Platform-specific binary packages (for example `*-darwin-arm64`, `@esbuild/*`, `@rolldown/*`) reflect the build host;
> other platforms resolve their own equivalents under the same licenses. Regenerate after dependency changes.

## MIT AND AGPL-3.0-only

@parity/truapi-host

## MIT

@apideck/better-ajv-errors, @astrojs/astro2tsx, @astrojs/check, @astrojs/compiler-binding,
@astrojs/compiler-binding-darwin-arm64, @astrojs/compiler-rs, @astrojs/internal-helpers, @astrojs/language-server,
@astrojs/markdown-satteri, @astrojs/prism, @astrojs/telemetry, @astrojs/yaml2ts, @babel/code-frame, @babel/compat-data,
@babel/core, @babel/generator, @babel/helper-annotate-as-pure, @babel/helper-compilation-targets,
@babel/helper-create-class-features-plugin, @babel/helper-create-regexp-features-plugin,
@babel/helper-define-polyfill-provider, @babel/helper-globals, @babel/helper-member-expression-to-functions,
@babel/helper-module-imports, @babel/helper-module-transforms, @babel/helper-optimise-call-expression,
@babel/helper-plugin-utils, @babel/helper-remap-async-to-generator, @babel/helper-replace-supers,
@babel/helper-skip-transparent-expression-wrappers, @babel/helper-string-parser, @babel/helper-validator-identifier,
@babel/helper-validator-option, @babel/helper-wrap-function, @babel/helpers, @babel/parser,
@babel/plugin-bugfix-firefox-class-in-computed-class-key, @babel/plugin-bugfix-safari-class-field-initializer-scope,
@babel/plugin-bugfix-safari-id-destructuring-collision-in-function-expression,
@babel/plugin-bugfix-safari-rest-destructuring-rhs-array,
@babel/plugin-bugfix-v8-spread-parameters-in-optional-chaining,
@babel/plugin-bugfix-v8-static-class-fields-redefine-readonly, @babel/plugin-proposal-private-property-in-object,
@babel/plugin-syntax-import-assertions, @babel/plugin-syntax-import-attributes, @babel/plugin-syntax-jsx,
@babel/plugin-syntax-unicode-sets-regex, @babel/plugin-transform-arrow-functions,
@babel/plugin-transform-async-generator-functions, @babel/plugin-transform-async-to-generator,
@babel/plugin-transform-block-scoped-functions, @babel/plugin-transform-block-scoping,
@babel/plugin-transform-class-properties, @babel/plugin-transform-class-static-block, @babel/plugin-transform-classes,
@babel/plugin-transform-computed-properties, @babel/plugin-transform-destructuring,
@babel/plugin-transform-dotall-regex, @babel/plugin-transform-duplicate-keys,
@babel/plugin-transform-duplicate-named-capturing-groups-regex, @babel/plugin-transform-dynamic-import,
@babel/plugin-transform-explicit-resource-management, @babel/plugin-transform-exponentiation-operator,
@babel/plugin-transform-export-namespace-from, @babel/plugin-transform-for-of, @babel/plugin-transform-function-name,
@babel/plugin-transform-json-strings, @babel/plugin-transform-literals,
@babel/plugin-transform-logical-assignment-operators, @babel/plugin-transform-member-expression-literals,
@babel/plugin-transform-modules-amd, @babel/plugin-transform-modules-commonjs, @babel/plugin-transform-modules-systemjs,
@babel/plugin-transform-modules-umd, @babel/plugin-transform-named-capturing-groups-regex,
@babel/plugin-transform-new-target, @babel/plugin-transform-nullish-coalescing-operator,
@babel/plugin-transform-numeric-separator, @babel/plugin-transform-object-rest-spread,
@babel/plugin-transform-object-super, @babel/plugin-transform-optional-catch-binding,
@babel/plugin-transform-optional-chaining, @babel/plugin-transform-parameters, @babel/plugin-transform-private-methods,
@babel/plugin-transform-private-property-in-object, @babel/plugin-transform-property-literals,
@babel/plugin-transform-regenerator, @babel/plugin-transform-regexp-modifiers, @babel/plugin-transform-reserved-words,
@babel/plugin-transform-shorthand-properties, @babel/plugin-transform-spread, @babel/plugin-transform-sticky-regex,
@babel/plugin-transform-template-literals, @babel/plugin-transform-typeof-symbol,
@babel/plugin-transform-unicode-escapes, @babel/plugin-transform-unicode-property-regex,
@babel/plugin-transform-unicode-regex, @babel/plugin-transform-unicode-sets-regex, @babel/preset-env,
@babel/preset-modules, @babel/runtime, @babel/template, @babel/traverse, @babel/types, @bruits/satteri-darwin-arm64,
@cacheable/memory, @cacheable/utils, @capsizecss/unpack, @clack/core, @clack/prompts, @commander-js/extra-typings,
@emmetio/abbreviation, @emmetio/css-abbreviation, @emmetio/css-parser, @emmetio/scanner, @emmetio/stream-reader,
@emmetio/stream-reader-utils, @emnapi/core, @emnapi/runtime, @emnapi/wasi-threads, @ensdomains/content-hash,
@esbuild/darwin-arm64, @eslint-community/eslint-utils, @eslint-community/regexpp, @eslint/js, @img/colour,
@jridgewell/gen-mapping, @jridgewell/remapping, @jridgewell/resolve-uri, @jridgewell/source-map,
@jridgewell/sourcemap-codec, @jridgewell/trace-mapping, @keyv/bigmap, @keyv/serialize, @napi-rs/wasm-runtime,
@noble/ciphers, @noble/curves, @noble/hashes, @oslojs/encoding, @oxc-project/types, @parity/truapi, @pkgr/core,
@polkadot-api/cli, @polkadot-api/codegen, @polkadot-api/ink-contracts, @polkadot-api/json-rpc-provider,
@polkadot-api/json-rpc-provider-proxy, @polkadot-api/known-chains, @polkadot-api/logs-provider,
@polkadot-api/merkleize-metadata, @polkadot-api/metadata-builders, @polkadot-api/metadata-compatibility,
@polkadot-api/observable-client, @polkadot-api/pjs-signer, @polkadot-api/raw-client, @polkadot-api/raw-tx-creator,
@polkadot-api/signers-common, @polkadot-api/sm-provider, @polkadot-api/smoldot, @polkadot-api/substrate-bindings,
@polkadot-api/substrate-client, @polkadot-api/tx-creator, @polkadot-api/utils, @polkadot-api/wasm-executor,
@polkadot-api/ws-middleware, @polkadot-api/ws-provider, @polkadot-labs/hdkd, @polkadot-labs/hdkd-helpers,
@prettier/parse-srcset, @rolldown/binding-darwin-arm64, @rolldown/pluginutils, @rollup/plugin-babel,
@rollup/plugin-node-resolve, @rollup/plugin-replace, @rollup/plugin-terser, @rollup/pluginutils,
@rollup/rollup-darwin-arm64, @rx-state/core, @scure/base, @scure/sr25519, @sec-ant/readable-stream, @sentry/browser,
@sentry/browser-utils, @sentry/bundler-plugins, @sentry/conventions, @sentry/core, @sentry/feedback, @sentry/replay,
@sentry/replay-canvas, @sentry/vite-plugin, @shikijs/core, @shikijs/engine-javascript, @shikijs/engine-oniguruma,
@shikijs/langs, @shikijs/primitive, @shikijs/themes, @shikijs/types, @shikijs/vscode-textmate,
@sindresorhus/merge-streams, @solidjs/babel-plugin, @solidjs/compiler, @solidjs/compiler-darwin-arm64,
@solidjs/compiler-wasm32-wasi, @solidjs/signals, @solidjs/testing-library, @solidjs/vite-plugin, @solidjs/web,
@testing-library/dom, @turbo/darwin-arm64, @tybys/wasm-util, @types/aria-query, @types/babel__core,
@types/babel__generator, @types/babel__template, @types/babel__traverse, @types/chai, @types/deep-eql, @types/esrecurse,
@types/estree, @types/estree-jsx, @types/hast, @types/json-schema, @types/mdast, @types/nlcst, @types/node,
@types/normalize-package-data, @types/qrcode, @types/resolve, @types/trusted-types, @types/unist,
@types/whatwg-mimetype, @types/ws, @typescript-eslint/eslint-plugin, @typescript-eslint/parser,
@typescript-eslint/project-service, @typescript-eslint/scope-manager, @typescript-eslint/tsconfig-utils,
@typescript-eslint/type-utils, @typescript-eslint/types, @typescript-eslint/typescript-estree, @typescript-eslint/utils,
@typescript-eslint/visitor-keys, @vitest/mocker, @vitest/spy, @volar/kit, @volar/language-core, @volar/language-server,
@volar/language-service, @volar/source-map, @volar/typescript, @vscode/emmet-helper, @vscode/l10n, acorn, acorn-jsx,
agent-base, ajv, ajv-draft-04, ajv-i18n, am-i-vibing, ansi-regex, ansi-styles, array-buffer-byte-length,
arraybuffer.prototype.slice, assertion-error, astro, astro-eslint-parser, async, async-function, available-typed-arrays,
babel-plugin-polyfill-corejs2, babel-plugin-polyfill-corejs3, babel-plugin-polyfill-regenerator, bail, balanced-match,
brace-expansion, browserslist, buffer-from, buffer-image-size, cacheable, call-bind, call-bind-apply-helpers,
call-bound, camelcase, ccount, chai, chalk, character-entities-html4, character-entities-legacy, chokidar, ci-info,
cli-cursor, cli-spinners, clsx, color-convert, color-name, comma-separated-tokens, commander, common-tags,
convert-source-map, cookie, cookie-es, core-js-compat, cross-spawn, crossws, crypto-random-string, css-tree, cssesc,
csso, csstype, data-view-buffer, data-view-byte-length, data-view-byte-offset, debug, decamelize, deep-is, deepmerge,
define-data-property, define-properties, defu, dequal, destr, detect-indent, devalue, devlop, dijkstrajs,
dom-accessibility-api, dom-serializer, dset, dunder-proto, emmet, emoji-regex, es-abstract, es-abstract-get,
es-define-property, es-errors, es-module-lexer, es-object-atoms, es-set-tostringtag, es-to-primitive, esbuild, escalade,
escape-string-regexp, eslint, eslint-config-prettier, eslint-plugin-astro, eslint-plugin-solid, eslint-plugin-turbo,
estree-walker, eta, eventemitter3, execa, extend, fast-deep-equal, fast-json-stable-stringify, fast-levenshtein,
fast-string-truncated-width, fast-string-width, fast-wrap-ansi, fdir, figures, file-entry-cache, find-proc, find-up,
flat-cache, flattie, fontace, fontkitten, for-each, fs-extra, fs.promises.exists, fsevents, function-bind,
function.prototype.name, functions-have-names, generator-function, gensync, get-east-asian-width, get-intrinsic,
get-proto, get-stream, get-symbol-description, get-tsconfig, globals, globalthis, gopd, h3, happy-dom, has-bigints,
has-property-descriptors, has-proto, has-symbols, has-tostringtag, hashery, hasown, hast-util-to-html,
hast-util-whitespace, hookified, html-entities, html-escaper, html-tags, html-void-elements, https-proxy-agent, ignore,
imurmurhash, index-to-position, inline-style-parser, internal-slot, iron-webcrypto, is-array-buffer, is-async-function,
is-bigint, is-boolean-object, is-callable, is-core-module, is-data-view, is-date-object, is-docker, is-document.all,
is-extglob, is-finalizationregistry, is-fullwidth-code-point, is-generator-function, is-glob, is-html, is-interactive,
is-map, is-module, is-negative-zero, is-number-object, is-obj, is-plain-obj, is-regex, is-regexp, is-set,
is-shared-array-buffer, is-stream, is-string, is-symbol, is-typed-array, is-unicode-supported, is-weakmap, is-weakref,
is-weakset, is-what, isarray, js-sha3, js-tokens, js-yaml, jsesc, json-schema-traverse,
json-stable-stringify-without-jsonify, json5, jsonc-parser, jsonfile, jsonpointer, kebab-case, keyv, kleur,
known-css-properties, leven, levn, locate-path, lodash.debounce, log-symbols, lz-string, magic-string, magicast,
math-intrinsics, mdast-util-to-hast, merge-anything, micromark-util-character, micromark-util-encode,
micromark-util-sanitize-uri, micromark-util-symbol, micromark-util-types, mimic-function, mrmime, ms, muggle-string,
nanoevents, nanoid, natural-compare, neotraverse, neverthrow, nlcst-to-string, node-fetch, node-fetch-native,
node-mock-http, node-releases, normalize-path, npm-run-path, object-inspect, object-keys, object.assign, obug, ofetch,
ohash, onetime, oniguruma-parser, oniguruma-to-es, optionator, ora, own-keys, p-limit, p-locate, p-queue, p-timeout,
p-try, package-manager-detector, parse-json, parse-ms, parse5, path-browserify, path-exists, path-key, path-parse,
pathe, picomatch, pngjs, polkadot-api, possible-typed-array-names, postcss, postcss-selector-parser, prelude-ls,
prettier, prettier-plugin-astro, pretty-bytes, pretty-format, pretty-ms, prismjs, process-ancestry, progress,
property-information, proxy-from-env, punycode, qified, qrcode, radix3, react-is, read-pkg, readdirp,
reflect.getprototypeof, regenerate, regenerate-unicode-properties, regex, regex-recursion, regex-utilities,
regexp.prototype.flags, regexpu-core, regjsgen, request-light, require-directory, require-from-string, resolve,
resolve-pkg-maps, restore-cursor, retext-smartypants, rolldown, rollup, rollup-plugin-esbuild, s.color,
safe-array-concat, safe-push-apply, safe-regex-test, sass-formatter, satteri, scale-ts, seroval, seroval-plugins,
set-function-length, set-function-name, set-proto, shebang-command, shebang-regex, shiki, side-channel,
side-channel-list, side-channel-map, side-channel-weakmap, sisteransi, smob, solid-js, sort-keys, source-map-support,
space-separated-tokens, spdx-expression-parse, std-env, stdin-discarder, stop-iteration-iterator, string-width,
string.prototype.matchall, string.prototype.trim, string.prototype.trimend, string.prototype.trimstart,
stringify-entities, strip-ansi, strip-comments, strip-final-newline, style-to-object, suf-log,
supports-preserve-symlinks-flag, svgo, synckit, tagged-tag, temp-dir, tempy, tiny-inflate, tinybench, tinyclip,
tinyexec, tinyglobby, tr46, trim-lines, trough, ts-api-utils, tsc-prog, turbo, type-check, typed-array-buffer,
typed-array-byte-length, typed-array-byte-offset, typed-array-length, typesafe-path, typescript-auto-import-cache,
typescript-eslint, ufo, ultrahtml, unbox-primitive, uncrypto, undici, undici-types,
unicode-canonical-property-names-ecmascript, unicode-match-property-ecmascript, unicode-match-property-value-ecmascript,
unicode-property-aliases-ecmascript, unicorn-magic, unified, unifont, unique-string, unist-util-is, unist-util-position,
unist-util-stringify-position, unist-util-visit, unist-util-visit-parents, universalify, unplugin-utils, unstorage,
upath, update-browserslist-db, util-deprecate, varint, verkit, vfile, vfile-message, vite, vite-plugin-pwa,
vite-plugin-wasm, vitefu, vitest, volar-service-css, volar-service-emmet, volar-service-html, volar-service-prettier,
volar-service-typescript, volar-service-typescript-twoslash-queries, volar-service-yaml, vscode-css-languageservice,
vscode-html-languageservice, vscode-json-languageservice, vscode-jsonrpc, vscode-languageserver,
vscode-languageserver-protocol, vscode-languageserver-textdocument, vscode-languageserver-types, vscode-nls, vscode-uri,
whatwg-mimetype, whatwg-url, which-boxed-primitive, which-builtin-type, which-collection, which-command,
which-typed-array, why-is-node-running, word-wrap, workbox-background-sync, workbox-broadcast-update, workbox-build,
workbox-cacheable-response, workbox-core, workbox-expiration, workbox-google-analytics, workbox-navigation-preload,
workbox-precaching, workbox-range-requests, workbox-recipes, workbox-routing, workbox-strategies, workbox-streams,
workbox-sw, workbox-window, wrap-ansi, write-json-file, write-package, ws, xxhash-wasm, yaml-language-server, yargs,
yocto-queue, yoctocolors, zod, zwitch

## Apache-2.0

@ampproject/remapping, @eslint/config-array, @eslint/config-helpers, @eslint/core, @eslint/object-schema,
@eslint/plugin-kit, @humanfs/core, @humanfs/node, @humanfs/types, @humanwhocodes/module-importer, @humanwhocodes/retry,
@img/sharp-darwin-arm64, @playwright/test, @trickfilm400/rollup-plugin-off-main-thread, aria-query, axobject-query,
baseline-browser-mapping, cborg, detect-libc, ejs, eslint-visitor-keys, expect-type, fake-indexeddb, filelist,
human-signals, jake, jsqr, playwright, playwright-core, rxjs, sharp, spdx-correct, typescript,
validate-npm-package-license, web-vitals

## Apache-2.0 OR MIT

@ipld/car, @ipld/dag-cbor, @ipld/dag-pb, @multiformats/sha3, ipfs-unixfs, multiformats, protons-runtime, uint8-varint,
uint8arraylist, uint8arrays

## Apache-2.0 AND MIT

@parity/truapi-provider

## ISC

@emmetio/html-matcher, @ungap/structured-clone, anymatch, at-least-node, boolbase, cliui, electron-to-chromium, flatted,
foreground-child, get-caller-file, get-own-enumerable-property-symbols, github-slugger, glob-parent, graceful-fs,
hosted-git-info, idb, isexe, lru-cache, minimatch, piccolore, picocolors, require-main-filename, semver, set-blocking,
signal-exit, simple-statistics, which, which-module, write-file-atomic, y18n, yallist, yaml, yargs-parser

## BSD-2-Clause

css-select, css-what, domelementtype, domhandler, domutils, dotenv, entities, eslint-scope, espree, esrecurse,
estraverse, esutils, http-cache-semantics, normalize-package-data, nth-check, regjsparser, stringify-object, terser,
uri-js, webidl-conversions

## BSD-3-Clause

deepmerge-ts, diff, esquery, fast-uri, serialize-javascript, smol-toml, source-map, source-map-js

## 0BSD

tslib

## BlueOak-1.0.0

@isaacs/cliui, common-ancestor-path, glob, jackspeak, lru-cache, minimatch, minipass, package-json-from-dist,
path-scurry, sax

## Python-2.0

argparse

## MIT OR CC0-1.0

type-fest

## CC0-1.0

mdn-data, spdx-license-ids

## CC-BY-3.0

spdx-exceptions

## CC-BY-4.0

caniuse-lite

## GPL-3.0-or-later WITH Classpath-exception-2.0

smoldot

## LGPL-3.0-or-later

@img/sharp-libvips-darwin-arm64

## MPL-2.0

@useragent-kit/polkavm-runtime browser artifacts, lightningcss, lightningcss-darwin-arm64

## FSL-1.1-MIT

@sentry/cli, @sentry/cli-darwin
