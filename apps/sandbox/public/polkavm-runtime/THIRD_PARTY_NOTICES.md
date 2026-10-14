# Third-party notices and redistribution

## License boundaries

The runtime's own covered source remains **Mozilla Public License 2.0**. The
repository `LICENSE` is unchanged; binary/package distributions carry the same
text as `LICENSE-MPL-2.0`. This does not relicense dependencies, source exceptions,
examples, fixtures, guest programs, or a host application as MPL.

These adapted source files retain their **Apache-2.0 OR MIT** exception:

| Runtime source | Upstream source |
| --- | --- |
| `rust/crates/polkavm-host-runtime/src/corevm.rs` | [PolkaVM `examples/quake/src/vm.rs`](https://github.com/paritytech/polkavm/blob/3df1d0309c4c81a1aad0a755d83570d203bba1d9/examples/quake/src/vm.rs) |
| `rust/crates/polkavm-host-runtime/src/quake_keys.rs` | [PolkaVM `examples/quake/src/keys.rs`](https://github.com/paritytech/polkavm/blob/3df1d0309c4c81a1aad0a755d83570d203bba1d9/examples/quake/src/keys.rs) |

Both originate at revision `3df1d0309c4c81a1aad0a755d83570d203bba1d9` and
have been adapted; their source headers identify that provenance. The exact
upstream Apache and MIT texts are included under `vendored-polkavm-examples` in
the license collection. This attribution concerns the host-side example code,
not a grant to distribute Quake game code or assets. The extracted WASM compiler
is runtime-owned MPL source, not a new copy of those upstream example files.

## Included license collection

`THIRD_PARTY_LICENSES.txt` accompanies this document in the flat browser/native
asset distribution. In the source repository it is at
`licenses/THIRD_PARTY_LICENSES.txt`; the machine-readable companion is
`licenses/dependency-inventory.json`.

The collection contains exact resolved crate names, versions, public source
identifiers, registry checksums or Git revisions, declared license expressions,
verbatim upstream license/copyright/NOTICE texts, and source notice blocks.
Identical texts are deduplicated by SHA-256 with explicit component mappings.
Cargo `authors` values are identified as metadata, not invented copyright claims.
Upstream license alternatives, exceptions and additional obligations are retained;
for example, an `AND Unicode-3.0` term is not replaced by MIT alone.
Package-level declarations are not the whole story: `khronos_api` also bundles
Khronos permission notices and ANGLE XML with BSD terms. Those source notices and
the ANGLE license at its exact vendored submodule revision are included too.

The inventory deliberately distinguishes:

- **`browser-default/runtime`**: normal dependency paths from
  `polkavm-host-runtime`, default features, target `wasm32-unknown-unknown`.
  These are candidates for inclusion in the shipped WASM, not proof that every
  crate contributes surviving machine code after optimization.
- **`browser-default/build`**: browser build/procedural-macro dependencies and
  their transitive dependencies. Some generate Rust/WASM code, so their notices
  are retained without calling them browser runtime dependencies.
- **`all-targets-all-features/runtime` and `/build`**: a conservative workspace
  superset including optional native FFI/GPU, export tools and other targets.
  Entries with only this scope are **not asserted to ship in browser WASM**.
  Cargo feature unification can overapproximate an individual release build.
- **Rust standard-library/toolchain notices**: the pinned toolchain's own
  `COPYRIGHT-library.html`, library license files (including compiler-builtins),
  and associated license texts. `std`, `core`, `alloc` and compiler support can
  be embedded in native/WASM artifacts without appearing in the workspace
  `Cargo.lock`. The broad standard-library notice set also covers components for
  targets not used in a particular artifact; it is not a linkage claim.

Dev-dependency edges are excluded. Dependency test/example/benchmark directories
are not scanned for source notices. This is not an inventory of separately
redistributed test guests, fixture binaries or sample applications. Their own
source provenance, lockfiles, compiler runtime and licenses must be checked if
they are distributed; do not apply this runtime's MPL declaration to them.

The browser npm manifest currently declares no runtime, optional, peer or bundled
third-party npm dependencies. The JavaScript package still distributes generated
Rust/WASM code, so the absence of npm dependencies does **not** remove the Rust
attribution obligations. The generator rejects newly added npm dependency fields
until their licensing has been reviewed.

### Upstream evidence limitations

Some crates omit license files from their published archives. Pinned public
upstream texts and their provenance are retained in
`licenses/upstream-supplements.json`, including the exact crate VCS revisions
where available. The generator does not fetch mutable branches or synthesize
copyright owners or years.

Two native/all-target dependencies need particular care:

- **`block` 0.1.6** declares MIT in its package metadata, but neither its archive
  nor [its upstream release revision](https://github.com/SSheldon/rust-block/tree/47178790cfc9d4a8b092051d8b413b78bd31254a)
  supplies a LICENSE file or named copyright notice. The collection includes
  canonical MIT terms, explicitly marked as a template rather than an upstream
  copyright statement, plus the verbatim package authors. This records the
  available evidence; it does not resolve the absent upstream notice.
- **`malloc_buf` 0.0.6** declares MIT but omits the license text. The collection
  includes the [upstream clarification added later](https://github.com/SSheldon/malloc_buf/commit/d9a3e539642bd90e07df458d226b19cdfa606863),
  including its actual copyright statement. Its date is preserved verbatim, not
  asserted as a date supplied by the 0.0.6 release.

These limitations are not browser dependency findings. Review them when shipping
native artifacts that include those packages. License metadata and this
conservative inventory are evidence, not a legal opinion or a guarantee that an
arbitrary downstream distribution has met every obligation.

## Redistributor checklist

1. **Identify the exact artifact and source.** Preserve its checksums, release
   record, source revision, `Cargo.lock`, build features/target and pinned Rust
   toolchain. Make the corresponding MPL-covered Source Code Form, including
   your modifications and the materials needed to modify it, available to
   recipients under MPL 2.0 by reasonable means in a timely manner, at no more
   than distribution cost. Tell recipients how to obtain it. An exact accessible
   release archive/revision is suitable; a moving branch, inaccessible private
   URL, or a package version alone is not a source offer.
2. **Carry notices with the artifact.** Include `LICENSE-MPL-2.0`, this document
   and the complete `THIRD_PARTY_LICENSES.txt` in the browser package and native
   asset export. Preserve applicable upstream copyright and NOTICE text, source
   headers, modification notices and license conditions. Keep these notices
   accessible if repackaging assets into an application bundle or installer.
3. **Respect each license separately.** Review the actual linked features and
   targets against the inventory. Follow the selected alternative where an `OR`
   permits a choice, all applicable `AND` terms, and any exception conditions.
   Preserve source availability for MPL-covered dependencies such as UniFFI when
   applicable; the root runtime source archive alone is not their source code.
4. **Keep host and guest boundaries clear.** MPL is file-level copyleft, not a
   blanket license for the whole host or for independent guest applications.
   Distributing the runtime does not license a consumer's host code, guest
   programs, content, fonts, media or platform SDKs. Conversely, loading a guest
   does not erase its own license obligations. Audit separately bundled guests,
   fixtures and external/native platform components.
5. **Regenerate after dependency/toolchain changes.** From the release source,
   with the pinned `rust-src` and `rust-docs` components installed, run:

   ```sh
   cargo fetch --locked
   node scripts/generate-third-party-notices.mjs
   node scripts/generate-third-party-notices.mjs --check
   ```

   The generator uses offline, locked Cargo metadata and locally fetched source;
   it does not compile or update the lockfile. Review new license expressions,
   omitted-file supplements and generated code before publishing. A missing
   license text fails generation rather than silently substituting an SPDX label.
   Rebuild/copy the flat notices with the same asset set so both the npm tarball
   and the native exporter contain the updated files. For different features,
   targets, dependencies or toolchains, review the resulting distribution rather
   than assuming the checked-in inventory is an exact binary bill of materials.
