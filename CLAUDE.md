# CLAUDE.md

ComfyUI custom-node pack with a thin Python backend (a node + HTTP endpoints in `touch_manager.py`) and a TypeScript frontend extension built to `web/dist/` via bun. See ADR-0001.

## The pattern ("the vein")

A mobile-first ComfyUI usability pack: a frontend extension that intercepts a widget interaction (`widget.onPointerDown`, modern Vue frontend) and opens a touch-friendly HTML modal in place of a clunky native LiteGraph control. Widgets are matched **by name** (generic across node packs), the enhancement is **additive** (graceful fallback to the native control, never breaks serialized workflows), and the modal is **touch-first** (16px inputs to avoid iOS zoom, big tap targets, momentum scroll). The modal primitives come from `@laurigates/comfy-modal-kit` (`openModalShell` / `fuzzyRank` / `highlightMatches`), imported and inlined by `bun build` — not copied into the pack.

## File layout

| Path | Purpose |
|------|---------|
| `src/index.ts` | The extension: widget interception + modal (consumes the modal kit). |
| `src/comfyui-shims.d.ts` | Types the `/scripts/app.js` runtime import (via the `paths` mapping in `tsconfig.json`). |
| `__init__.py` | Loader stub. Imports node mappings from the backend module; exports `WEB_DIRECTORY = "./web/dist"`. |
| `touch_manager.py` | Node + HTTP endpoints. Bundled libs only; arbitrary-path endpoints gate on an extension whitelist. |
| `web/dist/` | **Generated** by `bun run build` (git-ignored). ComfyUI serves it at `/extensions/comfyui-touch-manager/`. |
| `pyproject.toml` | Comfy Registry metadata. `PublisherId` + `version` are the fields you touch; `[tool.comfy] includes = ["web/dist"]` force-ships the built output. |
| `tsconfig.json` / `biome.json` / `knip.json` | Strict TS config, Biome lint/format, knip dead-code. |
| `.github/workflows/` | `ci.yml` (tsc+build/biome/vitest/ruff/pytest/gitleaks), `publish.yml` (builds then publishes on version bump), `release-please.yml`. |
| `tests/js/` | Vitest suite importing the `.ts` source directly. `tests/test_init.py` is the pytest backend suite. |
| `justfile` | `build`, `lint`, `format`, `test`, `check` recipes — the local CI gate. |

## Hard rules

- **Pack directory name is part of the URL.** `web/dist/index.js` is served at
  `/extensions/comfyui-touch-manager/index.js`. Renaming the pack dir breaks every fetch. If
  unavoidable, sync `EXT_NAME` in the source.
- **TypeScript source, bun build.** Author in `src/` (entry `src/index.ts`),
  build to `web/dist/` via `bun build ./src/index.ts --target browser --format
  esm --outdir web/dist --external '/scripts/*'`. `tsc --noEmit` is the type
  gate; `bun build` is the emit — they are decoupled. The `/scripts/app.js`
  import is left **unbundled** (resolved at runtime against ComfyUI's served
  module). See ADR-0001.
- **No new Python dependencies. Backend uses ComfyUI-bundled libs only (aiohttp, folder_paths, server). A feature needing another lib → a separate companion pack.**
- ****Modal primitives come from `@laurigates/comfy-modal-kit`** — import them, do NOT copy `modal-shell.js`/`modal-fuzzy.js` into the pack. `bun build` inlines the imported code into `web/dist`.**
- **Additive only.** Never clobber an existing tooltip/control; fall back to
  the native widget when there's no match. Never fabricate data.
- **Frontend hook is version-sensitive.** The modal opens via `widget.onPointerDown`. Keep an explicit button-widget fallback if you depend on the modal being reachable.
- **Never hand-edit `CHANGELOG.md` or the `version` field** — release-please
  owns them (conventional commits drive the bump).

## Dev workflow

```sh
uv sync --group dev          # ruff, pytest, pre-commit
bun install                  # TypeScript, Biome, Vitest, knip, @laurigates/comfy-modal-kit (inlined at build)
pre-commit install
just check                   # typecheck + build + lint + test — the local CI gate
```

Iterating on the frontend needs a **`bun run build`** (the served file is
`web/dist/index.js`, not the source) plus a browser hard-refresh — no ComfyUI
restart. Changes to `touch_manager.py` (backend) DO require a ComfyUI restart.

### Endpoint reachability check

```sh
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8188/extensions/comfyui-touch-manager/index.js
```

## Verify the frontend API against the sourcemap

The ComfyUI frontend (`comfyui-frontend-package`) ships **minified** — property
and method names are renamed in the bundle, so reading the running app's objects
by guessed names (or trusting old tutorials) is unreliable. The TypeScript types
from `@comfyorg/comfyui-frontend-types` cover `ComfyApp` but **not** the internal
`LGraphNode` / `LGraphCanvas` / widget interfaces (un-exported). Model the small
surface you touch with local structural interfaces, and verify the real shape
against the bundled sourcemap before coding against a LiteGraph / canvas API.

LiteGraph is bundled in the **`api-*.js.map`** chunk under
`.venv/lib/python*/site-packages/comfyui_frontend_package/static/assets/`. The
`.js.map` embeds the original TypeScript in `sourcesContent` — grep that, not the
minified `.js`:

```sh
cd .venv/lib/python*/site-packages/comfyui_frontend_package/static/assets
grep -l 'LGraphGroup' *.js.map        # find the chunk
```

Facts worth confirming this way (recheck on a `comfyui-frontend-package` bump):
`LiteGraph.NODE_TITLE_HEIGHT` (30); `canvas.selectedItems` is a
`Set<Positionable>` holding nodes + groups + reroutes; `canvas.selected_nodes` is
a node-only dictionary; canvas zoom is **wheel-driven**
(`processMouseWheel -> ds.changeScale`).

Two gotchas that follow: discriminate selected items by **shape, not
`instanceof`** (the class is renamed under minification); and to suppress native
zoom during a gesture, intercept `wheel` (capture, `passive:false`,
`preventDefault`), not just pointer events. Record what you confirm in a
"Verified frontend API" table above so the next change doesn't re-derive it.

## Releases

Merge the release-please PR → the published GitHub release triggers
`publish.yml`, which runs `bun run build`, publishes via
`Comfy-Org/publish-node-action`, and pushes the release notes to the registry
version changelog (the "Updates" section). Requires the
`REGISTRY_ACCESS_TOKEN` repo secret. Use conventional commits; release-please
maintains `CHANGELOG.md` and the version bump PR.
