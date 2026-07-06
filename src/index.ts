// Touch Node Manager — ComfyUI frontend extension entry point.
//
// TypeScript source in `src/`, built to ESM via `bun build` and emitted to
// `web/dist/` (served at /extensions/comfyui-touch-manager/index.js — the pack
// directory name IS the URL segment). Do not rename the pack dir without
// syncing EXT_NAME / the /touch_manager/ route namespace. See ADR-0001.
//
// This pack is a NODE MANAGER, not a widget interceptor. It opens a
// full-screen, touch-first modal (tabs: Installed / Updates / Install-from-URL
// / Core) that drives the /touch_manager/* backend routes. The modal itself
// lives in touch-manager-ui.ts; the pure helpers in manager-core.ts. This file
// is thin: it only registers the extension and wires the open entry points.
//
// The shared modal primitives come from @laurigates/comfy-modal-kit and are
// INLINED by `bun build` — not copied into this pack.
import { makeLauncher } from "@laurigates/comfy-modal-kit";
import { app } from "/scripts/app.js";
import { openManager } from "./touch-manager-ui";

const EXT_NAME = "comfyui-touch-manager";

// Command + shared Extensions > Touch Tools menu entry + action-bar button,
// built by the kit with the family conventions baked in (kebab command id,
// PrimeIcons, safe-open with a copyable error toast). Kit ADR-0002.
// NOTE: the command id changed from "TouchManager.Open" to
// "touch-manager.open" — user keybindings on the old id need re-binding.
const launcher = makeLauncher({
  id: "touch-manager.open",
  label: "Touch Node Manager",
  icon: "pi pi-th-large",
  failSummary: "Could not open Touch Node Manager",
  open: openManager,
});
// The launcher's command function IS the guarded opener; reuse it for the
// sidebar tab below so every entry point shares the same defensive boundary.
const safeOpen = launcher.commands[0]?.function ?? openManager;

app.registerExtension({
  name: "comfy.touch-manager",

  // Informational setting: surfaced in the Install tab and passed in the
  // install body, but the BACKEND bind gate is the real enforcement.
  settings: [
    {
      id: "TouchManager.AllowRemoteInstall",
      name: "Touch Manager: allow install from URL on non-loopback binds",
      tooltip:
        "Informational only — the server's TOUCH_MANAGER_ALLOW_REMOTE_INSTALL env + bind address are the real gate.",
      type: "boolean",
      defaultValue: false,
    },
    // `SettingParams.id` is typed `keyof Settings`; a custom id is intentional
    // here, so cast the array at the registration boundary.
  ] as unknown as Parameters<typeof app.registerExtension>[0]["settings"],

  ...launcher,

  // Optionally register a sidebar tab as a third entry point. Feature-detect
  // extensionManager (recent) and degrade silently if absent.
  setup() {
    try {
      const em = (app as { extensionManager?: { registerSidebarTab?: (t: unknown) => void } })
        .extensionManager;
      em?.registerSidebarTab?.({
        id: "touch-manager",
        type: "custom",
        title: "Node Manager",
        icon: "pi pi-th-large",
        tooltip: "Touch Node Manager",
        render: (container: HTMLElement) => {
          container.replaceChildren();
          const btn = document.createElement("button");
          btn.type = "button";
          btn.textContent = "Open Node Manager";
          btn.style.cssText =
            "margin:12px;min-height:44px;padding:10px 14px;font-size:15px;border-radius:8px;cursor:pointer;";
          btn.addEventListener("click", safeOpen);
          container.appendChild(btn);
        },
      });
    } catch (e) {
      console.warn(`[${EXT_NAME}] sidebar tab registration failed`, e);
    }
  },
});

// Re-export the pure helpers so the Vitest suite can import them from the
// barrel as well as from manager-core directly.
export {
  filterPacks,
  formatRef,
  formatUpdateStatus,
  sanitizePackName,
  validateInstallUrl,
  versionOptions,
} from "./manager-core";
