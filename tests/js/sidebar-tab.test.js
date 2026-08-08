// @vitest-environment jsdom
//
// The sidebar rail is now a SHORTCUT, not a panel: tapping the icon opens the
// manager modal and leaves nothing behind. Two routes deliver that — a
// toggle-command override (preferred; no panel is ever mounted) and, when the
// override cannot land, a collapse at the end of `render()`. This suite pins
// both, plus the removal of the old "Open Node Manager" fallback button that
// used to sit in the panel.
//
// Importing src/index.ts runs the extension's module side effect against
// tests/js/__mocks__/app.js, which records the registered extension object and
// every sidebar tab.
//
// ── WHAT THIS TIER CANNOT ASSERT ─────────────────────────────────────────────
// jsdom implements no layout and hosts no Vue app, so none of the following is
// checked here. They belong to the real-browser tier
// (`comfyui-plugin:comfyui-pack-live-smoke`, on the GPU box):
//   • Whether the one-frame empty panel on the FALLBACK route is perceptible,
//     and whether PrimeVue's Splitter re-runs its localStorage size restore on
//     the `display: flex|none` flip.
//   • Whether the override actually lands against a running Pinia command store
//     (`ComfyCommandImpl.function` is a plain public field and Vue never
//     proxies functions, so it should — but it has never been executed against
//     a live frontend). The read-back check makes a failure detectable; the
//     fallback makes it survivable.
//   • The rendered hit box of the shared Touch Tools action-bar button (the
//     `!h-11` override), and whether `pi pi-mobile` paints.
//   • That the rail icon no longer highlights, and that the auto-generated
//     command reads "Toggle Touch Node Manager Sidebar" — both are INTENDED
//     consequences of the override, visible only in a real frontend.
// No `getComputedStyle` assertions appear below because this change makes no
// CSS claim: the only styling it touched was the deleted button's inline
// `style.cssText`, and the honest pin for a deletion is structural (no
// `<button>` in the panel), not a style read.
import { getHubEntries } from "@laurigates/comfy-modal-kit";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { overrideToggleCommand } from "../../src/index.ts";
import { __registered, __reset, __responses, __sidebarTabs, app } from "./__mocks__/app.js";

const TOGGLE_ID = "Workspace.ToggleSidebarTab.touch-manager";

/** Let the modal's deferred initial load settle so it does not leak into the next test. */
const flush = () => new Promise((r) => setTimeout(r, 0));

/** The manager modal mounts the kit shell's `.cmp-dialog` on the body. */
const dialogs = () => document.querySelectorAll(".cmp-dialog");

describe("comfyui-touch-manager sidebar tab", () => {
  /** @type {Record<string, unknown>} */
  let ext;
  /** @type {Record<string, unknown>} */
  let tab;

  beforeAll(() => {
    ext = __registered.at(-1);
    // setup() registers the sidebar tab AND the Touch Tools chooser row.
    ext.setup();
    tab = __sidebarTabs.at(-1);
  });

  beforeEach(() => {
    document.body.replaceChildren();
    __reset();
    // Keep the modal's initial load quiet; its content is modal.test.js's job.
    __responses["/touch_manager/config"] = {
      ok: true,
      allow_remote_install: false,
      is_loopback: true,
      manager_enabled: false,
      reboot_allowed: true,
      delete_allowed: true,
    };
    __responses["/touch_manager/installed"] = { ok: true, packs: [] };
    app.extensionManager.sidebarTab.activeSidebarTabId = null;
    app.extensionManager.command.commands = [];
  });

  it("registers the frozen tab id and NO destroy handler", () => {
    expect(tab.id).toBe("touch-manager");
    // A `destroy` would be called by ExtensionSlot on unmount when
    // activeSidebarTabId goes null — i.e. one flush after render() opened the
    // modal — tearing down the very modal it had just opened.
    expect(Object.hasOwn(tab, "destroy")).toBe(false);
    expect(tab.destroy).toBeUndefined();
  });

  it("exposes the launcher command and exactly one (shared, hub) action-bar button", () => {
    expect(ext.commands.map((c) => c.id)).toContain("touch-manager.open");
    expect(ext.menuCommands[0].commands).toContain("touch-manager.open");
    // makeHubEntry emits no button; the single entry here is the family's
    // shared Touch Tools hub button from installHubButton(). The two spreads
    // are key-disjoint, so neither clobbered the other.
    expect(ext.actionBarButtons).toHaveLength(1);
    expect(ext.actionBarButtons[0].label).toBe("Touch Tools");
  });

  it("registers its chooser row from setup(), not module evaluation", () => {
    expect(getHubEntries().map((e) => e.id)).toContain("touch-manager.open");
  });

  it("render() appends NO button to the panel (the deleted fallback affordance)", async () => {
    const container = document.createElement("div");
    document.body.append(container);

    tab.render(container);

    // The regression pin: the panel used to carry an "Open Node Manager"
    // button. Its removal is the user-visible point of this change, and the
    // panel must now be empty of controls entirely.
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(container.childElementCount).toBe(0);
    // …while the modal itself did open, so "empty panel" is not "did nothing".
    expect(dialogs()).toHaveLength(1);
    await flush();
  });

  it("render() collapses the panel only when THIS tab is the active one", async () => {
    const container = document.createElement("div");
    document.body.append(container);

    app.extensionManager.sidebarTab.activeSidebarTabId = "touch-manager";
    tab.render(container);
    expect(app.extensionManager.sidebarTab.activeSidebarTabId).toBe(null);
    await flush();
  });

  it("render() leaves another tab's active id alone", async () => {
    const container = document.createElement("div");
    document.body.append(container);

    app.extensionManager.sidebarTab.activeSidebarTabId = "some-other-tab";
    tab.render(container);
    // Nulling an id we do not own would close somebody else's panel.
    expect(app.extensionManager.sidebarTab.activeSidebarTabId).toBe("some-other-tab");
    await flush();
  });

  it("render() twice leaves the SAME modal standing, not a rebuilt one", async () => {
    const container = document.createElement("div");
    document.body.append(container);

    // ExtensionSlot's inline function ref re-fires on every patch with no
    // identity guard, so render() must be idempotent with respect to the modal.
    tab.render(container);
    const first = document.querySelector(".cmp-dialog");
    expect(first).not.toBe(null);

    tab.render(container);

    // Counting dialogs is NOT the assertion: the kit coordinator's
    // setActiveModal has replace semantics, so an unguarded second open closes
    // the first and the count stays 1 either way (this suite's first draft
    // asserted exactly that, and the mutation harness proved it vacuous). The
    // real regression is a torn-down and rebuilt modal — the user's tab
    // selection, scroll and in-flight search all reset on every Vue patch — so
    // assert the dialog is the SAME node.
    expect(document.querySelector(".cmp-dialog")).toBe(first);
    expect(dialogs()).toHaveLength(1);
    await flush();
  });

  it("overrideToggleCommand() repoints a mutable toggle command at the manager", async () => {
    const original = () => {};
    const cmd = { id: TOGGLE_ID, function: original };
    app.extensionManager.command.commands = [cmd];

    expect(overrideToggleCommand()).toBe(true);
    expect(cmd.function).not.toBe(original);

    // The override IS the no-panel route: invoking it opens the manager and
    // never touches activeSidebarTabId, so no panel is mounted for any frame.
    app.extensionManager.sidebarTab.activeSidebarTabId = null;
    cmd.function();
    expect(dialogs()).toHaveLength(1);
    expect(app.extensionManager.sidebarTab.activeSidebarTabId).toBe(null);
    await flush();
  });

  it("the override route is idempotent: a second invocation keeps the SAME modal", async () => {
    // Both sidebar routes share openIfNoModal(). Without that, the PREFERRED
    // route (this one) would tear down and rebuild a modal the user is already
    // using — resetting tab selection, scroll and in-flight search. The shell
    // backdrop covers the rail so a tap cannot reach the toggle, but a user
    // keybinding on Workspace.ToggleSidebarTab.touch-manager dispatches
    // straight through (the shell stops propagation for Escape only).
    const cmd = { id: TOGGLE_ID, function: () => {} };
    app.extensionManager.command.commands = [cmd];
    expect(overrideToggleCommand()).toBe(true);

    cmd.function();
    const first = document.querySelector(".cmp-dialog");
    expect(first).not.toBeNull();

    cmd.function();
    // Node IDENTITY, not a count: a rebuilt modal also yields exactly one
    // dialog, so toHaveLength(1) would pass against the bug.
    expect(document.querySelector(".cmp-dialog")).toBe(first);
    await flush();
  });

  it("overrideToggleCommand() returns false on a FROZEN command without throwing", () => {
    const frozen = Object.freeze({ id: TOGGLE_ID, function: () => {} });
    app.extensionManager.command.commands = [frozen];

    // Assigning to a frozen property throws a TypeError in strict mode; the
    // guard must convert that into "use the fallback route", not an exception
    // escaping into ComfyUI's setup() dispatch.
    expect(() => overrideToggleCommand()).not.toThrow();
    expect(overrideToggleCommand()).toBe(false);
    expect(dialogs()).toHaveLength(0);
  });

  it("overrideToggleCommand() returns false when the write is silently swallowed", () => {
    // The exact case the read-back identity check exists for: a store that
    // accepts the assignment and keeps the old value. Without the read-back
    // this reports the override route while the rail still toggles a panel.
    const cmd = { id: TOGGLE_ID };
    Object.defineProperty(cmd, "function", {
      get: () => undefined,
      set: () => {},
      configurable: true,
    });
    app.extensionManager.command.commands = [cmd];

    expect(overrideToggleCommand()).toBe(false);
  });

  it("overrideToggleCommand() returns false when the command is absent", () => {
    app.extensionManager.command.commands = [{ id: "Workspace.ToggleSidebarTab.model-library" }];
    expect(overrideToggleCommand()).toBe(false);
  });
});
