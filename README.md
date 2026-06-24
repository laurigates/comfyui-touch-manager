# comfyui-touch-manager

Touch-first node/extension manager for ComfyUI: check updates, update nodes and core, install from a GitHub URL, select versions, fuzzy search — mobile-friendly.

> Part of a family of mobile-first ComfyUI usability packs
> ([gallery-loader](https://github.com/laurigates/comfyui-gallery-loader),
> [sampler-info](https://github.com/laurigates/comfyui-sampler-info)):
> touch-friendly HTML modals that replace clunky native LiteGraph
> controls, detected by widget name, additive and non-clobbering.

## Install

```sh
cd <ComfyUI>/custom_nodes
git clone https://github.com/laurigates/comfyui-touch-manager
cd comfyui-touch-manager
bun install
bun run build      # emit web/dist/ (served by ComfyUI)
```

Restart ComfyUI; hard-refresh the browser tab (Ctrl+Shift+R / Cmd+Shift+R).

## What it does

TODO — describe the widgets it enhances and the modal it opens.

## Compatibility

- ComfyUI: modern Vue frontend (`comfyui-frontend-package >= 1.40`) for the
  `widget.onPointerDown` interception hook.
- Frontend changes take effect after `bun run build` + a browser hard-refresh —
  no ComfyUI restart.

## License

MIT — see `LICENSE`.
