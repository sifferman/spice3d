# spice3d work log

A running log of what's been learned, decided, and completed while building spice3d.
Newest entries at the top.

---

## 2026-05-23 — Filled polygons + smooth-tube arcs

Two follow-ups after the user looked at the deployed render:

### Filled polygons

xschem polygons with `fill=true` (mosfet body-source arrowheads,
diode triangle, ipin/opin pin arrows, etc.) now render filled.
`xschem2spice` now stores `filled` on `xs_polygon` and `xs_box`,
populated by `xs_prop_get(props, "fill")`. The C++ side mirrors
both flags on `DrawingPolygon` and `DrawingBox`.

For the actual fill mesh we triangulate with
`Geometry2D::triangulate_polygon` (handles concave shapes like the
ipin arrow — fan triangulation would tear). Output is an
`ArrayMesh` with `PRIMITIVE_TRIANGLES`, vertices lying flat at
world y=0. We strip the trailing closing vertex (`vertex[0] == vertex[N-1]`)
since xschem polygons typically self-close in the source. Fill
material disables backface culling so the polygon is visible from
both above and below.

The capsule outline is still drawn on top of the fill — keeps the
silhouette crisp.

### Arcs as cylinders, not capsules

Capsules ended each tessellation segment with a hemispherical cap.
At low segment counts (or tight radii like the mosfet body circles)
those caps stacked up as visible "beads" along the arc. Switched
arc segments to `CylinderMesh` (no hemispheres) so adjacent
segments share endpoints and the curve looks continuous. Lines,
box outlines, and polygon outlines keep their capsules — those
benefit from the rounded ends.

---

## 2026-05-23 — All five drawing records rendered with rounded capsules

L, B, P, A, and T records (lines, boxes, polygons, arcs, and text
labels) are now all rendered. Edges are cylindrical with hemispherical
endcaps via `CapsuleMesh`, so every stroke looks like a smooth round
extrusion rising out of the table.

### Parser surface (xschem2spice)

The `.sym`/`.sch` parser used to silently skip L/A/P/T records and
only capture B records when they carried a `name=` (pin) property.
It now emits a single flat list per symbol/schematic:

```c
typedef struct {
    char tag;  /* 'L', 'B', 'P', 'A', or 'T' */
    union {
        xs_line       line;
        xs_box        box;
        xs_polygon    polygon;
        xs_arc        arc;
        xs_text_label text;
    } data;
} xs_drawing_record;
```

Each `xs_symbol` and `xs_schematic` exposes `drawing_records[]` in
parse order, preserving draw stack from the source file. The
netlister sees the same data it saw before (its B-as-pin logic is
unchanged), so SPICE output is byte-stable.

### Consumer surface (spice3d)

`schematic_loader` mirrors that with a C++ `std::variant`:

```cpp
using DrawingRecord = std::variant<
        DrawingLineSegment,
        DrawingBox,
        DrawingPolygon,
        DrawingArc,
        DrawingText>;
```

`ComponentInstance::symbol_drawing_records_in_local_coordinates`
holds records as they live in the symbol file (symbol-local frame).
`Schematic::top_level_drawing_records_in_global_coordinates` holds
records authored at the schematic level directly.

### Rendering pipeline

A single `render_drawing_record_in_global_coordinates` uses
`std::visit` to dispatch on the variant. For per-component records,
`transform_symbol_local_drawing_record_to_schematic_global` first
applies the instance's rotation+flip+placement (delegating point
transforms to xschem2spice's `xs_transform_pin_to_global`) and
returns a new record in schematic-global coords; then the same
dispatcher handles it. Top-level schematic records skip the
transform.

Per record type:

- **L**: one `CapsuleMesh` between the two endpoints, oriented in
  the XZ plane with its long Y-axis along the segment.
- **B**: four perimeter capsules (corners covered by overlapping
  hemispheres of adjacent capsules).
- **P**: open chain of N-1 capsules through the vertices; xschem
  polygons typically repeat the first vertex at the end to close
  themselves so the visual loop happens for free.
- **A**: tessellated into capsules of at most ~6° each; xschem's
  CCW-on-screen convention maps to schematic_y = center_y − r·sin(θ)
  because schematic y points down (so does world z after lying flat).
- **T**: `Label3D` lying flat (rotated −π/2 about world X), then
  rotated by the record's `rotation_quarter_turns` about world Y.
  `pixel_size` is derived from xschem's vertical size factor.

### Wires too

Wires switched from `BoxMesh` to the same `CapsuleMesh` helper for
consistency — they now share `add_capsule_segment_between_two_schematic_points`
with the drawing-record renderers.

### Capsule orientation

`basis_aligning_local_y_axis_with_xz_plane_direction` builds a
right-handed basis directly (X = (−dz, 0, dx), Y = (dx, 0, dz),
Z = (0, 1, 0)) so the capsule's long Y-axis lies along the segment
without any Euler-angle ordering gotchas.

---

## 2026-05-23 — Symbol-internal rendering (L + B primitives from .sym files)

Components no longer render as uniform placeholder cubes. Each
resolved `.sym` file is now scanned for `L` (line) and `B` (box)
records, and each record is materialized as a `BoxMesh` in the
schematic plane:

- `L` records → thin lying-flat box meshes (outline strokes)
- `B` records → low-profile rectangular box meshes (pin/region markers)
- `P` / `A` / `T` records are skipped for the first cut (polygons,
  arcs, text labels — deferred)

### `src/scene/symbol_drawing_loader.{h,cpp}` (new)

A lightweight C++ scanner that reads a `.sym` file line by line and
returns `SymbolDrawingPrimitivesInLocalCoordinates`. Each line's
first character drives a switch — only `L` and `B` are parsed (via
`istringstream`, dropping the unused color integer). All coordinates
remain in symbol-local space; the caller transforms them.

### Symbol-local → schematic-global transform

We reuse `xs_transform_pin_to_global` from xschem2spice (already
linked) to rotate/flip a `(symbol_local_x, symbol_local_y)` by the
component's `rotation_quarter_turns` + `flip_flag`, then add the
component's `placement_x` / `placement_y`. This is the same code
path the netlister uses for pin coordinates, so the rendered
outlines stay aligned with the wires.

### Render dispatch (`add_rendered_meshes_for_schematic_to_parent_node`)

Per component:
- If `symbol_was_resolved && !resolved_symbol_path.empty()` →
  draw symbol primitives (outlines + pin markers).
- Otherwise → fall back to the existing placeholder cube. This
  keeps unresolved components visible during PDK/xschem fetch
  failures rather than silently dropping them.

Outline material is a warm yellow (`0.95, 0.85, 0.4`); pin-marker
material is the same amber as the old placeholder cube but emissive
so terminals read clearly from above. Both materials are built once
per render pass and shared across all instances.

### Coord-helper gotcha

When the lying-flat refactor renamed
`schematic_xy_to_godot_world_position_with_y_flipped` →
`schematic_xy_to_lying_flat_world_position`, the new symbol-drawing
helpers referenced the old name in two places. Compiled-then-fixed
locally before commit.

---

## 2026-05-23 — Fetching xschem stdlib + sky130 PDK at startup; CORS strategy

End-to-end, the deployed site now fetches the xschem device-symbol
library and the sky130 PDK on first load, caches both in IndexedDB
(via `user://`), and renders the bundled `button_test.sch` against
those caches. Cold start ~6 seconds; subsequent loads are instant
cache hits.

### What's CORS-clean and what isn't

The browser fetch path forced specific choices because GitHub's
infrastructure isn't uniformly CORS-friendly:

| Endpoint | CORS? | Used for |
|---|---|---|
| `raw.githubusercontent.com/<owner>/<repo>/<sha>/<path>` | ✅ `*` | nothing currently |
| `cdn.jsdelivr.net/gh/<owner>/<repo>@<sha>/<path>` (repo content) | ✅ `*` | xschem `.sym` files (per-file) |
| `data.jsdelivr.com/v1/packages/gh/...` (file listing) | ✅ `*` | xschem repo file listing |
| `api.github.com/repos/.../releases/tags/<tag>` | ✅ `*` | sky130 ciel release metadata + SHA-256 digests |
| `github.com/<owner>/<repo>/archive/<sha>.zip` | ❌ | — |
| `github.com/<owner>/<repo>/releases/download/<tag>/<file>` | ❌ | — (needs proxy) |
| `release-assets.githubusercontent.com/...` (redirect target) | ❌ | — |
| `www-archive.fossi-foundation.org/ciel-releases/.../manifest.json` (final URL) | ✅ `*` | ciel version manifest (note: `fossi-foundation.github.io` redirects here via HTTP — hit the final HTTPS URL directly to avoid mixed-content) |

GitHub has declined CORS on Releases downloads for over a decade
— "release downloads are an authenticated user action, not a
programmable web resource." Won't change soon.

### Xschem stdlib — jsDelivr per-file, in parallel

`main.gd` fetches the device-symbol listing from
`data.jsdelivr.com/v1/packages/gh/StefanSchippers/xschem@<sha>?structure=flat`,
filters to `*/xschem_library/devices/*.sym` (~125 files), then
issues all 125 `HTTPRequest`s in parallel via `cdn.jsdelivr.net`.
A small ref-counted barrier (`AllParallelHttpRequestsFinishedSignalEmitter`)
awaits the last one. Total wall time on the test deploy: ~3.5 s
cold, instant warm. Cache layout:

  user://xschem_stdlib/<xschem-sha>/devices/*.sym
  user://xschem_stdlib/<xschem-sha>/.fetch_complete

The directory is passed as an `extra_symbol_search_directories`
entry to `Spice3DNode.load_schematic_and_render_into_node3d` so
the schematic loader's library path picks it up without copying
files into each schematic's staging directory.

### sky130 PDK — Cloudflare Worker proxy + SHA-256 verify

ciel's release archives are GitHub Release assets, which have no
CORS — and jsDelivr only mirrors repo content, not releases. The
ciel project itself can't fix this because the asset CDN is
controlled by GitHub, not them. Public CORS proxies in 2026 are
all dead or gated (corsproxy.io rejects deployed origins,
cors.sh doesn't answer, allorigins.win is 522, etc.).

Solution: a tiny Cloudflare Worker in `infra/cors-proxy/` that
fronts ciel-releases asset URLs with `Access-Control-Allow-Origin: *`.
Allowlisted to URLs starting with
`https://github.com/fossi-foundation/ciel-releases/releases/download/`
so it can't be used as a generic CORS bypass. Free tier (100k
req/day, no credit card) is far more than we need — first-load
fetches once, cache hits forever. Live at
`https://ciel-cors-proxy.sifferman.workers.dev`.

The Worker is *untrusted by design*. Trust comes from the
SHA-256 digest field on the GitHub release API response (which
is CORS-clean and authoritative). Flow:

  1. GET `api.github.com/.../releases/tags/sky130-<ciel-version>`
     -> assets[].{name, browser_download_url, digest: "sha256:..."}
  2. For each archive we want, GET via the Worker proxy.
  3. Hash the response with `HashingContext.HASH_SHA256`.
  4. Compare to the digest from step 1. Mismatch -> abort, no
     extraction, no cache update.
  5. Hand verified bytes to C++
     `Spice3DNode.extract_zstd_tar_archive_filtered_by_path_substring`
     with `["/libs.tech/combined/", "/libs.tech/xschem/"]` as the
     keep-substrings — zstd-decompress + USTAR-parse + filter +
     write in one C++ call, ~700 ms for the 17 MB decompressed.

For now we fetch only `common.tar.zst` (6.5 MB), which contains
both `sky130A` and `sky130B` variants' `libs.tech/{combined,xschem}`
subtrees — 2325 files after filtering, ~18 MB on disk. The
per-library archives (sky130_fd_pr, sky130_fd_sc_hd, …) total
~3 GB and are 99% layout/GDS data we don't want. Skip them for
now; lazy-fetch later if/when a schematic references a cell from
a library that isn't in `common`.

Cache layout:

  user://sky130/<ciel-version>/sky130A/libs.tech/{combined,xschem}/...
  user://sky130/<ciel-version>/sky130B/libs.tech/{combined,xschem}/...
  user://sky130/<ciel-version>/.fetch_complete

Both `sky130A/libs.tech/xschem` and `sky130B/libs.tech/xschem` are
passed as extra symbol search directories.

### When the upstream pins move

- xschem upstream SHA: const in `main.gd`. Bump by editing
  `XSCHEM_UPSTREAM_GIT_SHA`. Cache path includes the SHA so the
  on-disk cache busts automatically.
- sky130 ciel version: const in `main.gd` (currently
  `SKY130_CIEL_VERSION`). Same cache-busting behavior. The next
  step is auto-picking the latest non-pre-release from the ciel
  manifest at startup; tracked separately.
- Worker code: under `infra/cors-proxy/`. Redeploy with
  `wrangler deploy` from that directory.

### IndexedDB persistence

Godot's `user://` on web is IDBFS-backed (i.e., IndexedDB under
the hood). `navigator.storage.persist()` is requested via
`JavaScriptBridge` at startup to ask the browser not to evict
under storage pressure. The two caches above survive page
reloads, tab close+reopen, and (with the persist hint) browser
storage cleanup heuristics.

---

## 2026-05-23 — Pin engine + godot-cpp to 4.4.1 (godot#111645)

Godot 4.5 introduced a race in the editor's documentation generator
([godot#111645](https://github.com/godotengine/godot/issues/111645)):
`_load_doc_thread` enqueues `EditorHelp::_gen_extensions_docs` via
`call_deferred`, then `EditorHelp::cleanup_doc` can race in and
`memdelete(doc)`, so the deferred call dereferences a freed (or
reallocated-empty) `DocTools` instance. Any project with a
GDExtension that runs `godot --headless --import` hits it on a 4.5+
engine — including our pages.yml deploy.

The fix is not in any released Godot version, including current
master. So we pin both the engine and `godot-cpp` to 4.4.1:

- `godot-cpp` submodule → `godot-4.4.1-stable` tag
- `GODOT_VERSION` in pages.yml → 4.4.1
- `compatibility_minimum` in spice3d.gdextension → "4.4"
- `config/features` in project.godot → "4.4"
- `.gitmodules` `branch = 4.4` for godot-cpp

When godot#111645 is fixed upstream and shipped in a stable release,
bump these together.

Also added `.claude/` to `.gitignore`.

### Invariants to preserve when bumping to 4.5/4.6+

- **The `.gitmodules` `branch = ...` field for godot-cpp was removed on
  purpose.** `actions/checkout` honors the recorded SHA, not the branch
  field, so the line did nothing for CI but would let
  `git submodule update --remote` silently move the pin to whatever was
  at that branch's tip. To bump the pin, check out the desired tag in
  the submodule and stage it: `git -C godot-cpp checkout godot-X.Y-stable
  && git add godot-cpp`. The `.gdextension` `compatibility_minimum` and
  the godot-cpp SHA must advance together or the runtime check fails
  with `Cannot load a GDExtension built for Godot X.Y using an older
  version of Godot`.
- **godot-cpp prebuilt cache key (in pages.yml) is SHA-derived.** Bumping
  the submodule cold-builds the whole library once (~3–4 min on the
  4-core runner with `scons -j$(nproc)`) and then cache-hits thereafter.
- **pages.yml builds the GDExtension twice on one runner.** Once for web
  (`target=template_release`, `wasm32`, `threads=no`) for the deploy
  payload, once for linux (`target=template_debug`, `x86_64`) so the
  host-side `godot --headless --import` can resolve `Spice3DNode` and
  the export's `main.gd` parses cleanly. Both file paths in the
  `.gdextension` must exist or `--import` fails to load the extension.
- **`threads=no` on the web build is load-bearing.** godot-cpp's default
  `threads=yes` produces `libspice3d.web.template_release.wasm32.wasm`
  (no `.nothreads`), but the `.gdextension` and the Godot web export
  preset (`variant/thread_support=false`) both look for the `.nothreads`
  variant. Mismatched naming → `Failed to open …wasm32.nothreads.wasm`.

---

## 2026-05-23 — First live deploy + visible sanity label

Deploy went live at https://ethan.sifferman.dev/spice3d/. The page loaded
into a gray rectangle — main.tscn was a plain `Node` (non-visible
container), so the scene rendered nothing. The console line
`spice3d 0.1.0-dev - backend: web (...)` was the only proof the stack
worked.

Replaced main.tscn root with a `Control` + `ColorRect` background +
centered `Label`. main.gd now writes the version + backend tag into the
Label as well as printing it. The page itself now confirms at a glance
that the GDExtension loaded, Spice3DNode registered, and WEB_ENABLED
selected the right backend.

Also visible in the console:
- `WebAssembly try' instruction is deprecated, use 'try_table'` — emcc
  deprecation warning; benign, harmless, upstream Godot's problem.
- `An AudioContext was prevented from starting automatically` — Chrome
  autoplay policy; benign until we play audio.
- `Source map error: URL constructor: is not a valid URL` — Firefox
  devtools artifact on the wasm Module; benign.

---

## 2026-05-23 — coi-serviceworker fetch 404 fixed (no tags exist)

Pages run 26321115822 cleared every previous failure — both GDExtension
binaries built, import + export succeeded — then 404'd at:
`https://raw.githubusercontent.com/gzuidhof/coi-serviceworker/v0.1.7/coi-serviceworker.js`

Root cause: I invented `v0.1.7`. The coi-serviceworker repo has **no
tags at all** (confirmed via `/repos/gzuidhof/coi-serviceworker/tags`
returns `[]`); only a `master` branch.

Fix: pin to the current master SHA
`7b1d2a092d0d2dd2b7270b6f12f13605de26f214` and rename the env var to
`COI_SERVICEWORKER_GIT_SHA` to make the pinning style explicit at the
callsite. Verified the SHA-pinned URL returns HTTP 200.

SHA pinning is the right pattern here regardless of whether tags
existed — moving tags would silently change a deployed dependency.

---

## 2026-05-23 — Coding-standards sweep across all session-added code

User set a project-wide style: self-documenting names, no comments,
verbose/non-vague identifiers, no jargon, const + pure preferred, lots of
small helpers, reuse over reimplementation. Saved as a feedback memory.

Renames touched the entire public C++ surface added this session. Key
changes:

| Was | Is |
|---|---|
| `Sample` | `SimulationSample` |
| `SimInitInfo` | `SimulationNodeNames` |
| `SampleQueue::push/drain/clear/size_approx` | `push_sample/take_all_samples/clear_all_samples/approximate_buffered_count` |
| `SpiceSimulator::create()` | `create_for_current_platform()` |
| `load_netlist/start_transient/stop/is_running/set_external_voltage/drain_samples/init_info` | `load_netlist_lines/start_transient_analysis/stop_simulation/is_simulation_running/set_external_voltage_source/take_buffered_samples/get_node_names_when_ready` |
| `SpiceSimulatorNative` | `LibngspiceSpiceSimulator` |
| `SpiceSimulatorWeb` | `WebWorkerSpiceSimulator` |
| `trampoline_send_char` (jargon) | `ngspice_send_char_callback` |
| `on_send_data_vec/on_send_init_info/on_get_vsrc_data` | `receive_simulation_sample/receive_node_names/provide_external_voltage_value` |
| `Schematic::wires/components` fields | unchanged on the struct but field names within scope are descriptive |
| `Pin { name, dir, x, y }` | `ComponentPin { pin_name, pin_direction, global_x, global_y }` |
| `ComponentInstance { name, symref, ... }` | `ComponentInstance { instance_name, symbol_reference, rotation_quarter_turns, ... }` |
| `WireSegment { x1, y1, x2, y2, label }` | `WireSegment { start_x, start_y, end_x, end_y, net_label }` |
| `SchematicLoadResult { ok, error, schematic }` | `{ was_successful, error_message, loaded_schematic }` |
| `load_schematic()` | `load_schematic_from_file()` |
| `Spice3DNode::version/is_web_backend/simulator_backend/load_schematic` | `get_spice3d_version/is_running_on_web_platform/describe_simulator_backend/load_schematic_into_dictionary` |
| `SPICE3D_VERSION` macro | `SPICE3D_VERSION_STRING` |

GDScript main.gd, both project/web/*.js files, and the smoke test were
updated to match the new API.

### Things I dropped because the name didn't survive the test
- `lazily_constructed_simulator` → just `simulator`. "Lazily constructed"
  is an implementation note, not the identifier's meaning.
- `kBrowserSideBridgeBootstrapScript` (jargon: "bridge", "bootstrap") →
  inlined into the one call site as a raw string literal. The named
  constant existed only to justify multi-line string formatting.
- `build_library_path_from_inputs` (vague) → split into
  `load_xschemrc_into_library_path_if_provided` and
  `append_search_paths_to_library_path`.
- `copy_parsed_schematic_into_result` (vague "result") → split into
  `wires_from_parsed_xschem`, `components_from_parsed_xschem`, and
  `schematic_from_parsed_xschem` (each returns what its name says).

### Comments
Stripped all explanatory and orientation comments. Closing-namespace
`} // namespace foo` markers stayed (Godot/godot-cpp convention; helpful
across nested namespaces). Inline `/*param_name*/` annotations for unused
function params replaced with either C-style nameless params (cleanest in
.cpp) or `(void)name;` casts inside the function body (when the header
binds a name).

### Verification
`make -C test run` still passes:
- `button_test: OK (cell=button_test, 3 components, 0 wires)`
- `3bit_counter: OK (cell=3bit_counter, 14 components, 24 wires, 24 labelled)`

`third_party/xschem2spice` left untouched — that submodule has its own
conventions and is upstream's to govern.

---

## 2026-05-23 — Web export green: threads=no + host linux GDExtension

### Failure mode (from API-fetched run 26320550032)
SCons happily built `bin/web/libspice3d.web.template_release.wasm32.wasm`
— **no `.nothreads`** — while em++ emitted
`-sSIDE_MODULE + pthreads is experimental`. The `.gdextension` and export
preset both point at `.wasm32.nothreads.wasm`, so Godot's web export step
threw `Failed to open … wasm32.nothreads.wasm`.

Root cause: godot-cpp 4.3's `threads` SCons option defaults to `True`. It
only appends `.nothreads` to the suffix when threads are explicitly off.
Fix: pass `threads=no` to the SCons web build. (Pages.yml's export preset
already had `variant/thread_support=false` — the two have to match.)

### Second failure mode in the same run
`godot --headless --import` runs **on the Linux runner** and tries to load
`project/bin/linux/libspice3d.linux.template_debug.x86_64.so` so it can
register `Spice3DNode` from the GDExtension. We never built that binary in
the deploy job, so the symbol stayed undefined, so `main.gd` failed to
parse `Spice3DNode.new()`, so the exported pck contained a broken script.
Bug 1's wasm error happened to mask this — fixing only Bug 1 would still
have shipped a broken site.

Fix: build the GDExtension **twice** on the deploy runner — once for web
(template_release/single/threads=no, the deploy payload) and once for
linux (template_debug/x86_64, host-side only for `--import`). Separate
SCons caches per platform.

### Other hardening
- Added a `Verify GDExtension binaries are in place` step before the
  Godot install step: `ls -lR project/bin` + `test -f` on the two
  expected paths. Future "missing binary" failures will now be clear and
  early instead of buried 200 lines into Godot's export trace.
- ci.yml's matrix now passes `threads=no` when `platform=web` so the
  compile-sanity matrix exercises the same variant we deploy. Other
  platforms are unaffected.

### Action-log access works now
Re-issued PAT has `repo` scope (the previous one was `public_repo`-only
and 404'd on this private repo). With the new token, the GitHub Actions
REST API is reachable from this shell — used it to pull the exact build
log for run 26320550032 and confirm the wasm name mismatch before
writing the fix. Token is in conversation memory only; never written
to disk or memory files.

---

## 2026-05-22 — Windows build fix (upstream) + pages on claude

### Windows MSVC failed on `libgen.h`
First CI run with the new pages workflow surfaced
`fatal error C1083: Cannot open include file: 'libgen.h'`
in `third_party/xschem2spice/src/parser.c` line 35. Two findings:
- `parser.c` includes `<libgen.h>` but never calls dirname/basename —
  `basename_without_extension()` is hand-rolled with `strrchr`. Dead include.
- `xschemrc.c` does use `dirname(dup)` in `parent_directory()`. That needed
  a real portable shim.

Fixed upstream in xschem2spice on branch `windows-build-fix`
(commit `a8a38bb`):
- Drop the dead `<libgen.h>` from parser.c.
- Replace `parent_directory()` with a `strrchr`-based walker that also
  recognises `\\` on `_WIN32`. Matches POSIX `dirname` semantics for the
  cases this codebase exercises.
Verified locally: xschem2spice's Make build + spice3d's schematic_loader
smoke test still pass.

Updated spice3d's submodule pointer to that commit. **Important:** the fix
is local until pushed to `origin/windows-build-fix` on xschem2spice — until
then, CI in spice3d will fail to fetch the submodule at this SHA.

### pages.yml now triggers on `claude` too
Added `claude` to the push branches so AI-driven work can be previewed
live without merging first. Single-site repo — most recent successful
deploy wins, which is the desired staging behavior.

### Action log access from this environment
Can't reach GitHub Actions logs: no `gh` CLI installed; bare `curl` against
`api.github.com/repos/sifferman/spice3d/actions/runs` returns 404
(repo is private; no token is configured for this shell). Until that gap
is closed, "what's the CI status?" → user-pasted failure text is the
fastest path.

---

## 2026-05-22 — xschem parser via xschem2spice

### Decision: don't reimplement, reuse
Per the design doc and user direction, spice3d parses `.sch` / `.sym` files by
linking [xschem2spice](https://github.com/sifferman/xschem2spice) directly
into the GDExtension. xschem2spice already mirrors xschem 3.4.7's parsing
pipeline (distilled in `parser.c` and `netlist.c`) and is LVS-verified
against the real `xschem` binary in its own CI. Reimplementing the L/B/P/A/T
walker in C++ would be a year of bugs xschem2spice has already fixed.

Submodule lives at `third_party/xschem2spice/` (https URL — git@ would
require SSH credentials on every clone).

### Surface
- `src/scene/schematic_loader.{h,cpp}` — pure C++/STL, no godot-cpp
  dependency. Takes a `.sch` path + optional xschemrc, returns a
  `SchematicLoadResult { ok, error, Schematic { wires, components } }`.
  Component pins are pre-transformed into global coords via
  `xs_transform_pin_to_global`.
- `Spice3DNode::load_schematic(sch_path, xschemrc_path)` — Godot-callable
  shim that returns a `Dictionary` with the same data. GDScript-friendly.

### What's *missing* in xschem2spice for the renderer
xschem2spice keeps the netlisting view — wires (N records) and instances
(C records) — but discards the .sym drawing primitives (L/B/P/A/T tags).
The renderer can do a v0 visualization with just wires + pin markers +
bounding boxes, but real transistor body art will need either:
  (a) extending xschem2spice to retain drawing primitives, or
  (b) a parallel lightweight scanner in spice3d that only reads L/B/P/A/T
      and discards everything else.
(a) is cleaner since the user owns xschem2spice. Tracked as future work.

### Smoke test
`test/test_schematic_loader.cpp` links schematic_loader.cpp against
xschem2spice's C sources (no Godot toolchain) and runs against the
example schematics in `../spice3d_notes/examples`. Today it asserts:
- `button_test.sch` → 3 components, 0 wires, cell=button_test.
- `3bit_counter.sch` → 14 components, 24 wires, all wires labelled.

Both pass locally. CI runs the same test on every push — `parser-test` job
in `.github/workflows/ci.yml` checks out `sifferman/spice3d_notes` as a
sibling for the example data, then `make -C test run`.

### Build glue
- `CMakeLists.txt`: added `LANGUAGES CXX C`, listed the 5 xschem2spice C
  files explicitly (excluding `xschem2spice.c` which has a CLI `main()`),
  added the include path.
- `SConstruct`: same — Glob with an explicit exclude of `xschem2spice.c`.

---

## 2026-05-22 — ngspice dual-backend scaffold

### `src/sim/` layout
```
sim/
├── spice_simulator.h        public interface (Sample, SimInitInfo, SpiceSimulator)
├── spice_simulator.cpp      factory: #ifdef WEB_ENABLED picks one
├── sample_queue.h           thread-safe FIFO (mutex+vector for v0)
├── native/                  libngspice impl (gated by SPICE3D_HAVE_LIBNGSPICE)
└── web/                     JavaScriptBridge → Worker impl (stub)
```

### Key API decisions
- **Samples carry timestamps** (`Sample::time`). Non-uniform tran steps mean
  the renderer must place each on the wall-clock timeline, not assume a fixed
  rate — captured directly in the type.
- **Drain-based ingress** (`drain_samples()`). v0 uses a `std::mutex`-guarded
  `std::vector` (sample_queue.h). Renderer polls each frame. A SAB ring buffer
  can swap in later without changing the public API.
- **External voltage sources keyed by lowercase name**. ngspice reports the
  callback name lowercased ("vbutton1"); host code can pass any case.
- **`save none` + `esave node`** issued before `bg_tran` to keep ngspice from
  accumulating an unbounded plot — design doc constraint.
- **`bg_tran` not `tran`**. Background transient lets ngspice run on its own
  thread and `ngSpice_Command("bg_halt")` from Godot's thread is how we stop.

### Native compile gate
`SPICE3D_HAVE_LIBNGSPICE` controls whether `sharedspice.h` is included and
ngspice C calls are made. Until libngspice is available locally / in CI, the
native backend compiles as a stub that returns false from `load_netlist` and
no-op everywhere else. Spice3DNode::simulator_backend() advertises this in
its return string so GDScript can distinguish "native (libngspice)" from
"native (stub)".

### Web Worker harness (placeholder)
`project/web/ngspice_bridge.js` and `project/web/ngspice_worker.js` are in
place but do nothing useful yet. Bridge sets up `globalThis.spice3d` with the
expected method names; worker just acks `ready` and errors on every other
message. pages.yml copies both files into the Pages output so they live at
predictable URLs the moment the real WASM is ready.

### Open questions / not verified
- Have not confirmed `godot_cpp/classes/java_script_bridge.hpp` is the
  correct header path in godot-cpp 4.3 — only validated empirically once a
  web build runs in CI.
- `JavaScriptBridge::get_singleton()->eval(...)` is the simplest path for
  the C++ → JS direction. JS → C++ direction is harder and likely needs to
  flow through a `JavaScriptObject` callback registered from GDScript;
  parking that for the real wiring pass.

---

## 2026-05-22 — GitHub Pages deploy workflow

Added `.github/workflows/pages.yml`. On every push to `main`:
1. Build the GDExtension for web (wasm32, single, `template_release`) via the
   existing `setup-godot-cpp` action from the godot-cpp 4.3 submodule.
2. Install Godot 4.3-stable + matching export templates.
3. Run `--headless --import` twice (first run dies before imports finish; the
   second pass is reliably clean), then `--headless --export-release "Web"`
   into `build-web/`.
4. Fetch `coi-serviceworker.js` and inject `<script src="coi-serviceworker.js">`
   into the first `<head>` tag of Godot's exported `index.html`. Idempotent.
5. Upload via `actions/upload-pages-artifact@v3` → `actions/deploy-pages@v4`.

### Why coi-serviceworker, even with Godot threads off
The GDExtension wasm is built `nothreads` (Godot 4.3 GDExtension web support
is the nothreads variant). Godot itself runs single-threaded in the main
context. But the ngspice WASM module will live in a **separately spawned**
Web Worker that we control, and that worker needs SharedArrayBuffer to talk
to Godot on the hot path. GitHub Pages can't serve COOP/COEP headers, so the
Service Worker shim is what gets us cross-origin-isolation at runtime.

### Export preset choices (`project/export_presets.cfg`)
- `variant/extensions_support=true` — required for GDExtension on web.
- `variant/thread_support=false` — matches `nothreads.wasm` paths in the
  `.gdextension`.
- `progressive_web_app/ensure_cross_origin_isolation_headers=true` — Godot
  4.3's own header-injection helper. Belt-and-suspenders with coi-serviceworker.

### Open questions / not verified
- The pages workflow has not been run end-to-end yet (no CI in this loop).
  Most likely failure points if it breaks on first run:
  - `~/.local/share/godot/export_templates/4.3.stable/` path (Godot's expected
    template root may differ between minor versions).
  - The `.tpz` unzips to a `templates/` directory we then move from — verify
    on first CI run.
  - The `actions/deploy-pages` step needs the repo's Pages source to be set
    to "GitHub Actions" in repo settings; we cannot do that from CI.

