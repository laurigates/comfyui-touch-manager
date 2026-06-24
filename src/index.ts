// Touch Node Manager — ComfyUI frontend extension.
//
// TypeScript source in `src/`, built to ESM via `bun build` and emitted to
// `web/dist/` (served at /extensions/comfyui-touch-manager/index.js — the pack directory
// name IS the URL segment). Do not rename the pack dir without syncing
// EXT_NAME below (used for log prefixes and any /touch_manager/ fetches).
// See ADR-0001.
//
// Pattern (shared with gallery-loader / sampler-info / touch-numeric):
//   registerExtension -> enhance each node (on create AND on graph load) ->
//   wrap widget.onPointerDown on widgets matched BY NAME -> open an HTML
//   modal instead of the native LiteGraph control. Additive + mobile-first;
//   always chain to the original handler and fall back to the native control.
//   Requires the modern Vue frontend's onPointerDown hook
//   (comfyui-frontend-package >= 1.40).
//
// The shared modal primitives come from @laurigates/comfy-modal-kit. They are NOT copied
// into this pack — `bun build` INLINES the imported code into web/dist. To add
// fuzzy search to the modal, import the matcher from the same package:
//   import { fuzzyRank, highlightMatches } from "@laurigates/comfy-modal-kit";
//   fuzzyRank(query, [primaryField, ...otherFields]) -> { score, primaryMatches } | null
import { openModalShell } from "@laurigates/comfy-modal-kit";
// ComfyUI serves its frontend API at runtime from `/scripts/app.js`. The
// emitted import string stays `/scripts/app.js` (bun's `--external '/scripts/*'`
// keeps it unbundled); the type is supplied via a `paths` mapping in
// tsconfig.json that points the import at `src/comfyui-shims.d.ts`. See ADR-0001.
import { app } from "/scripts/app.js";

const EXT_NAME = "comfyui-touch-manager";

// Widgets this pack enhances, detected by NAME (generic across node packs).
// TODO: tune this set for the pack.
const TARGET_WIDGETS = new Set<string>([]);

// ============================================================
// Types — the narrow LiteGraph surface this pack reaches into
// ============================================================
//
// `@comfyorg/comfyui-frontend-types` exports `ComfyApp` (the type of the
// imported `app`) but NOT `LGraphNode` / the widget interfaces — they are
// declared internally and not re-exported. Model the small surface this pack
// touches with local structural interfaces instead (narrow blast radius).

// A widget plus the custom props this pack hangs off it. `onPointerDown` and
// the private guard flag are this pack's intercept seam, not part of the
// public widget surface.
interface PatchedWidget {
  name: string;
  onPointerDown?: (pointer: unknown, node: PatchedNode, canvas: unknown) => boolean | undefined;
  _touchManagerPatched?: boolean;
}

// Minimal structural type for the LiteGraph node this pack operates on. Named
// to avoid colliding with the package's own un-exported `LGraphNode` at the
// registerExtension lifecycle-hook seam — the hooks receive the package node,
// which we cast to this structural shape.
interface PatchedNode {
  type?: string;
  widgets?: PatchedWidget[];
}

// ============================================================
// Modal
// ============================================================

function openPicker(widget: PatchedWidget, node: PatchedNode | null): void {
  // CONTRACT: openModalShell has NO `body` option — it returns a controller
  // ({ bodyEl, close, setBusy, setStatus, ... }) with an EMPTY bodyEl that you
  // fill AFTER opening. Passing `body:` is silently ignored and the dialog
  // renders empty (a bug that passes green unit tests — only a jsdom/browser
  // check catches it). Always: open, then modal.bodyEl.appendChild(...).
  const modal = openModalShell({
    title: widget.name,
    onClose: () => {},
  });

  // TODO: build the real modal body. This skeleton proves the interception
  // + modal-shell wiring works end to end. Use fuzzyRank for search.
  const body = document.createElement("div");
  body.textContent = `Touch Node Manager: picker for "${widget.name}" on ${node?.type} — implement me.`;
  modal.bodyEl.appendChild(body);
}

// ============================================================
// Wiring
// ============================================================

function enhanceNode(node: PatchedNode): void {
  for (const w of node?.widgets ?? []) {
    if (!TARGET_WIDGETS.has(w.name)) continue;
    if (w._touchManagerPatched) continue; // guard against double-patching
    w._touchManagerPatched = true;

    // Strategy A: wrap onPointerDown. Chain to the original first; only open
    // our modal if the original didn't consume the event. Fall back to the
    // native control on error (additive — never break the widget).
    const origDown = w.onPointerDown;
    w.onPointerDown = function (
      this: PatchedWidget,
      pointer: unknown,
      ownerNode: PatchedNode,
      canvas: unknown,
    ): boolean | undefined {
      try {
        if (typeof origDown === "function") {
          const consumed = origDown.call(this, pointer, ownerNode, canvas);
          if (consumed) return consumed;
        }
        openPicker(w, ownerNode || node);
        return true; // consume — suppresses the native control
      } catch (e) {
        console.warn(`[${EXT_NAME}] picker open failed`, e);
        return false; // fall back to native on error
      }
    };
  }
}

app.registerExtension({
  name: "comfy.touch-manager",
  // Handle freshly created nodes AND nodes restored from a saved graph. The
  // lifecycle-hook node params are the package's own `LGraphNode`; cast each to
  // the structural `PatchedNode` this pack operates on.
  async nodeCreated(node) {
    try {
      enhanceNode(node as unknown as PatchedNode);
    } catch (e) {
      console.warn(`[${EXT_NAME}] nodeCreated enhance failed`, e);
    }
  },
  async loadedGraphNode(node) {
    try {
      enhanceNode(node as unknown as PatchedNode);
    } catch (e) {
      console.warn(`[${EXT_NAME}] loadedGraphNode enhance failed`, e);
    }
  },
});

// Re-export the pure helpers a real implementation adds here, so the Vitest
// suite (tests/js) can import them directly from the .ts source. The seed
// example is a placeholder — replace with this pack's own helpers.
export function clampToTargets(name: string): boolean {
  return TARGET_WIDGETS.has(name);
}
