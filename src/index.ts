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
import { app } from "/scripts/app.js";
import { openManager } from "./touch-manager-ui";

const EXT_NAME = "comfyui-touch-manager";
const OPEN_COMMAND_ID = "TouchManager.Open";

// Open the manager defensively — never let a failure bubble into ComfyUI's
// command/menu/button dispatch.
function safeOpen(): void {
  try {
    openManager();
  } catch (e) {
    console.error(`[${EXT_NAME}] failed to open node manager`, e);
  }
}

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

  // A command so the manager is reachable from the command palette and menu.
  commands: [
    {
      id: OPEN_COMMAND_ID,
      label: "Touch Node Manager",
      icon: "pi pi-th-large",
      function: () => safeOpen(),
    },
  ],

  // Surface the command under the Extensions menu group.
  menuCommands: [
    {
      path: ["Extensions"],
      commands: [OPEN_COMMAND_ID],
    },
  ],

  // A top action-bar button — the primary touch entry point.
  actionBarButtons: [
    {
      icon: "pi pi-th-large",
      tooltip: "Touch Node Manager",
      onClick: () => safeOpen(),
    },
  ],

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
