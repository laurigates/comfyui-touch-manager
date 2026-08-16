// Touch Node Manager — ComfyUI frontend extension entry point.
//
// TypeScript source in `src/`, built to ESM via `bun build` and emitted to
// `web/dist/` (served at /extensions/comfyui-touch-manager/index.js — the pack
// directory name IS the URL segment). Do not rename the pack dir without
// syncing EXT_NAME / the /touch_manager/ route namespace. See ADR-0001.
//
// This pack is a NODE MANAGER, not a widget interceptor. It opens a
// full-screen, touch-first modal (tabs: Installed / Install-from-URL /
// Registry / Core) that drives the /touch_manager/* backend routes. The
// Installed list shows available updates inline (lazy-loaded). The modal itself
// lives in touch-manager-ui.ts; the pure helpers in manager-core.ts. This file
// is thin: it only registers the extension and wires the open entry points.
//
// The shared modal primitives come from @laurigates/comfy-modal-kit and are
// INLINED by `bun build` — not copied into this pack.
import { installHubButton, makeHubEntry, registerHubEntry } from "@laurigates/comfy-modal-kit";
import { app } from "/scripts/app.js";
import { deleteGateStatusElement, openManager } from "./touch-manager-ui";

const EXT_NAME = "comfyui-touch-manager";

// Command + shared Extensions > Touch Tools menu entry + the pack's row in the
// family chooser, built by the kit with the family conventions baked in (kebab
// command id, PrimeIcons, safe-open with a copyable error toast). Kit ADR-0002.
//
// `makeHubEntry` emits NO action-bar button: the family owns exactly ONE, the
// shared "Touch Tools" hub button claimed by `installHubButton()` below. The
// two results are KEY-DISJOINT by construction (`hub.ts`), which is why they
// can be spread as siblings on the registration object.
//
// No `priority` here: comfyui-image-browser takes 10 and therefore sorts above
// this row in the chooser, which is the intended order (it is the
// higher-frequency tool).
//
// NOTE: the command id changed from "TouchManager.Open" to
// "touch-manager.open" — user keybindings on the old id need re-binding.
const entry = makeHubEntry({
  id: "touch-manager.open",
  label: "Touch Node Manager",
  icon: "pi pi-th-large",
  description: "Install, update and remove custom nodes",
  failSummary: "Could not open Touch Node Manager",
  open: openManager,
});
// The launcher's command function IS the guarded opener; reuse it for the
// sidebar tab below so every entry point shares the same defensive boundary.
const safeOpen = entry.commands[0]?.function ?? openManager;

/**
 * Open the manager unless one is already up (the shell mounts a `.cmp-dialog`
 * on the body).
 *
 * BOTH sidebar routes must share this guard, and the sharing is the point.
 * `openManager` has no re-entrancy guard of its own — it calls `openModalShell`
 * unconditionally, and the kit coordinator's `setActiveModal` dismisses the
 * previous modal and mounts a fresh one, resetting tab selection, scroll and
 * any in-flight search. Guarding only the render() path left the *preferred*
 * route (the toggle-command override) able to tear down and rebuild a modal the
 * user was already using: the shell backdrop covers the rail, so a tap cannot
 * reach the toggle, but a user keybinding bound to
 * `Workspace.ToggleSidebarTab.touch-manager` dispatches straight through
 * (the shell stops propagation for Escape only).
 */
function openIfNoModal(): void {
  if (!document.querySelector(".cmp-dialog")) safeOpen();
}

/**
 * Collapse the sidebar panel this tab would otherwise slide out.
 *
 * The rail icon is a SHORTCUT, not a panel: the manager lives in a full-screen
 * modal, so the panel behind it is dead space. Setting `activeSidebarTabId` to
 * null closes it on the next flush.
 *
 * `extensionManager.sidebarTab` is a runtime-only surface NOT declared on the
 * public `ExtensionManager` interface, so it is feature-detected exactly the
 * way the existing `em?.registerSidebarTab?.` check is.
 */
function collapseSidebarPanel(): void {
  try {
    const st = (
      app as { extensionManager?: { sidebarTab?: { activeSidebarTabId?: string | null } } }
    ).extensionManager?.sidebarTab;
    if (st && st.activeSidebarTabId === "touch-manager") st.activeSidebarTabId = null;
  } catch (e) {
    console.warn(`[${EXT_NAME}] sidebar collapse failed`, e);
  }
}

/**
 * Repoint the auto-generated `Workspace.ToggleSidebarTab.touch-manager` command
 * at the manager modal, so tapping the rail icon never touches
 * `activeSidebarTabId` at all and no panel is mounted for even one frame.
 *
 * This is upstream's own mechanism, not a novel hack: `sidebarTabStore.ts:83-92`
 * branches inside this same command for `model-library`.
 *
 * MUST be called from `setup()`, immediately after `registerSidebarTab` returns
 * — the ordering is load-bearing. `loadExtensionCommands` runs inside
 * `registerExtension` (`extensionService.ts:85`) while `invokeExtensionsAsync("setup")`
 * runs much later, so a declarative `commands:` override of the toggle id would
 * simply be clobbered by the auto-generated command.
 *
 * @returns whether the override landed; false means the render-collapse
 * fallback in `render()` is the active route.
 *
 * Exported for `tests/js/sidebar-tab.test.js`: which route is active is the
 * whole behaviour of this change, so the read-back must be exercised against
 * both a mutable and a frozen command object.
 */
export function overrideToggleCommand(): boolean {
  try {
    const cmds = (
      app as {
        extensionManager?: { command?: { commands?: Array<{ id: string; function?: unknown }> } };
      }
    ).extensionManager?.command?.commands;
    const cmd = cmds?.find((c) => c.id === "Workspace.ToggleSidebarTab.touch-manager");
    if (!cmd) return false;
    const fn = (): void => {
      openIfNoModal();
    };
    cmd.function = fn;
    // Read-back identity. Vue never proxies function values (`isObject` is
    // `typeof val === 'object'`), so a write that lands returns the exact
    // reference. A false here means the write did not stick.
    return cmd.function === fn;
  } catch (e) {
    console.warn(`[${EXT_NAME}] toggle-command override failed`, e);
    return false;
  }
}

app.registerExtension({
  name: "comfy.touch-manager",

  // Informational setting: surfaced in the Install tab and passed in the
  // install body, but the BACKEND bind gate is the real enforcement.
  settings: [
    {
      // FROZEN. Persistence is keyed on `id` end-to-end (`settingStore.ts`);
      // renaming it silently resets the user's stored value. `category` is
      // read only by the nav highlight and search facets, never by the
      // load/store path, so re-keying it is value-safe in both directions.
      id: "TouchManager.AllowRemoteInstall",
      // The `<h3>` group heading below now supplies the pack name, so the old
      // "Touch Manager: " prefix would spell the pack a third way.
      name: "Allow install from URL on non-loopback binds",
      // Three elements with a DISTINCT third: two settings sharing an identical
      // FULL category array silently collapse into one — `buildTree` reuses the
      // node at that path and overwrites `parent.data` (`treeUtil.ts:24-38`), so
      // the first vanishes from the dialog while its value stays stored.
      // "Touch Tools" is `FAMILY_SETTINGS_CATEGORY` in @laurigates/comfy-modal-kit.
      category: ["Touch Tools", "Touch Node Manager", "Remote install"],
      // Settings render in REVERSE registration order within a group
      // (`flattenTree` pops a stack, `treeUtil.ts:57-66`), and the sort is
      // stable on all-zero sortOrder. 100 is the family-uniform group maximum,
      // which keeps group ordering alphabetical.
      sortOrder: 100,
      tooltip:
        "Informational only — the server's TOUCH_MANAGER_ALLOW_REMOTE_INSTALL env + bind address are the real gate.",
      type: "boolean",
      defaultValue: false,
    },
    {
      // The delete gate's LIVE state, mirrored where an operator hunting for
      // "why can't I delete anything" actually looks. The Installed-tab
      // callout only speaks while the gate is refusing and the tab is open;
      // someone who reads it without shell access at that moment had no way
      // to re-find the env var name afterwards.
      id: "TouchManager.RemoteDeleteStatus",
      name: "Delete on non-loopback binds",
      // DISTINCT third element, per the comment on the entry above: two
      // settings sharing an identical FULL category array collapse into one.
      category: ["Touch Tools", "Touch Node Manager", "Remote delete"],
      sortOrder: 100,
      tooltip:
        "Informational only — the server's TOUCH_MANAGER_ALLOW_REMOTE_DELETE env + bind address are the real gate.",
      // A custom renderer, NOT a stored boolean. This is status: the value is
      // read from GET /touch_manager/config on every render, so the dialog
      // cannot claim delete is enabled while the backend refuses.
      type: () => deleteGateStatusElement(),
      defaultValue: null,
    },
    // `SettingParams.id` is typed `keyof Settings`; a custom id is intentional
    // here, so cast the array at the registration boundary.
  ] as unknown as Parameters<typeof app.registerExtension>[0]["settings"],

  ...entry,
  ...installHubButton(),

  // Register a sidebar tab as a third entry point. Feature-detect
  // extensionManager (recent) and degrade silently if absent. Selecting the
  // vertical-nav icon opens the manager modal and leaves NO panel behind:
  // either the toggle-command override fires (preferred — no panel is ever
  // mounted) or `render()`'s trailing collapse closes it on the next flush.
  setup() {
    // Register the chooser row HERE, not at module evaluation.
    // `invokeExtensionsAsync` iterates `enabledExtensions`
    // (`extensionService.ts:214`), but `registerExtension` runs for every loaded
    // extension and every extension file is imported regardless of the disable
    // list — so a module-eval registration would list DISABLED packs.
    registerHubEntry(entry.hubEntry);

    try {
      const em = (app as { extensionManager?: { registerSidebarTab?: (t: unknown) => void } })
        .extensionManager;
      em?.registerSidebarTab?.({
        // FROZEN. Renaming this id renames the auto-generated command
        // `Workspace.ToggleSidebarTab.touch-manager` (sidebarTabStore.ts:68).
        // A user keybinding on the old id is then re-added at boot with NO
        // isRegistered gate (keybindingService.ts:116-124), squats its combo,
        // is unlistable in the Keybinding panel (which enumerates registered
        // COMMANDS), and throws on press (commandStore.ts:110).
        id: "touch-manager",
        type: "custom",
        // Feeds the auto-generated command's label, which therefore reads
        // "Toggle Touch Node Manager Sidebar" — a lie once the click opens a
        // modal, and the title string is the only lever. Accepted: it appears
        // in the Keybinding panel and menubar, never on the rail.
        title: "Touch Node Manager",
        icon: "pi pi-th-large",
        tooltip: "Touch Node Manager",
        // Do NOT add a `destroy` here. `CustomExtension.destroy` is optional
        // (extensionTypes.ts:34) and ExtensionSlot calls it on unmount when
        // activeSidebarTabId goes null (ExtensionSlot.vue:26-30). The
        // render-collapse fallback below unmounts this slot one flush after
        // opening the modal, so a destroy that tears the manager down would
        // close the modal it had just opened, with no error anywhere.
        render: (container: HTMLElement) => {
          container.replaceChildren();
          // Open the modal as soon as the tab is shown — via the SHARED guard,
          // so re-rendering the panel never stacks or rebuilds a modal.
          // `ExtensionSlot`'s inline function ref re-fires on every patch with
          // no identity guard, so this idempotence check is load-bearing, not
          // defensive noise.
          openIfNoModal();
          // Nothing is appended to the panel — no fallback button, no chrome.
          // The panel is not a place the user should ever end up looking at, so
          // collapse it. MUST be the last statement: the collapse unmounts this
          // very slot.
          collapseSidebarPanel();
        },
      });

      // Immediately after registerSidebarTab returns — see the function's doc
      // comment for why this cannot be a declarative `commands:` override.
      const overridden = overrideToggleCommand();
      console.info(
        `[${EXT_NAME}] sidebar opens the manager ${
          overridden ? "via command override" : "via render-collapse fallback"
        }`,
      );
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
  hoistPacksWithUpdates,
  sanitizePackName,
  validateInstallUrl,
  versionOptions,
} from "./manager-core";
