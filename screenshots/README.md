# README screenshot pipeline

Containerized [Playwright](https://playwright.dev) + ComfyUI generator that
regenerates the README screenshot (`docs/manager.png`) reproducibly, so the
shot doesn't depend on whatever packs/theme/frontend a particular dev machine
happens to have.

## Run

From the repo root:

```sh
just screenshots
```

First build is ~4 min (clones ComfyUI, installs CPU torch + ComfyUI deps,
installs bun + builds the pack frontend, pulls the npm driver dep on top of the
pre-baked Chromium). Cached rebuilds are ~30s. The PNG lands at
`docs/manager.png`.

## How it works

This pack is an **app-level node manager**, not a widget interceptor — there's
no node widget to tap, and the modal's data comes from the `/touch_manager/*`
backend routes rather than a seeded model directory. So the driver differs from
the widget-interceptor packs in two ways:

1. `Dockerfile` builds on the official Playwright image (Node 22 + Chromium
   pre-installed), clones a pinned ComfyUI release, installs CPU-only torch +
   ComfyUI's requirements, then `bun install && bun run build` to compile the
   pack's frontend bundle (`web/dist/index.js`).
2. `entrypoint.sh` launches ComfyUI headless on `:8188` (`--cpu`), waits for
   `/system_stats`, then runs the capture driver.
3. `capture.mjs` (Playwright):
   - **Stubs** every `/touch_manager/*` route with `page.route`, returning
     representative JSON that matches the real handler shapes in
     `touch_manager.py` (`config`, `installed`, `updates/list`,
     `updates/check`). The shot is therefore deterministic and needs no real
     custom_nodes, git remotes, or network.
   - Opens the modal by invoking the pack's **registered command function**
     (`app.extensions[…].commands[0].function` — the same call the top
     action-bar button's `onClick` fires, i.e. `openManager()`).
   - Switches to the **Updates** tab, runs "Check for updates" (answered
     instantly by the stub), and screenshots the `.cmp-dialog` showing several
     packs with updates available + their incoming-commit previews.
4. The driver writes to `/out`, which the `just` recipe mounts to `docs/`.

| File | Purpose |
|------|---------|
| `Dockerfile` | Single-stage build (Playwright base + ComfyUI + CPU torch + bun frontend build). |
| `Dockerfile.dockerignore` | Keeps the build context lean. |
| `entrypoint.sh` | Boots ComfyUI, waits for ready, runs the driver, asserts `$EXPECTED_OUTPUTS` exist. |
| `capture.mjs` | Playwright driver — stubs the backend, opens the manager modal, shoots the Updates tab. |
| `workflow.json` | Minimal single-Note graph so the canvas loads (the modal is app-level). |
| `package.json` | Pins the Playwright npm version for the driver. |

## Pins (bump deliberately)

- **`ARG COMFYUI_REF`** (`Dockerfile`) — the ComfyUI release. The modal is
  rendered by the frontend bundle that ships with this release; `v0.22.0`
  ships `comfyui-frontend-package==1.43.18`, clearing the pack's `>=1.40`
  floor (the action-bar button / command registration surface).
- **Playwright version** — pinned in BOTH `Dockerfile` (`FROM
  mcr.microsoft.com/playwright:v1.49.1-noble`) and `package.json`. Keep them
  in lockstep: the base-image tag pins the Chromium revision (the largest
  source of cross-host font-rendering drift) and the npm dep is the driver
  API. Bump both together.

## Don't hand-edit `docs/manager.png`

It's generated. To change it, edit `capture.mjs` (the modal-open path or the
stubbed data) and re-run `just screenshots`.
