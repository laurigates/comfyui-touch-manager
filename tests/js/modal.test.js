// @vitest-environment jsdom
//
// Smoke test for the modal BUILDER itself — the gap pure-helper tests miss.
// openModalShell + the tabbed body are DOM-only, so a green pure-function
// suite can coexist with an empty or unwired modal. This mounts the real
// openManager() against a jsdom document and asserts the shell renders all
// four tabs, calls the backend, and paints loaded data into the body.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RECONNECT_POLL } from "../../src/manager-core.ts";
import { openManager, reloadController } from "../../src/touch-manager-ui.ts";
import {
  __fetchBodies,
  __fetchCalls,
  __fetchControl,
  __reset,
  __responses,
} from "./__mocks__/app.js";

// Let queued microtasks + the deferred initial load settle.
const flush = () => new Promise((r) => setTimeout(r, 0));

// A minimal installed git-pack row, as GET /touch_manager/installed returns it.
const gitPack = (name) => ({
  name,
  path: `/x/${name}`,
  root: "/x",
  is_git: true,
  ref: { type: "branch", name: "main", sha: "abc1234" },
  remote_url: `https://github.com/laurigates/${name}`,
  dirty: false,
  enabled: true,
});

describe("openManager (jsdom modal smoke)", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    __reset();
    __responses["/touch_manager/config"] = {
      ok: true,
      allow_remote_install: true,
      is_loopback: true,
      manager_enabled: false,
      reboot_allowed: true,
      delete_allowed: true,
    };
    __responses["/touch_manager/installed"] = {
      ok: true,
      packs: [
        {
          name: "comfyui-touch-resize",
          path: "/x/comfyui-touch-resize",
          root: "/x",
          is_git: true,
          ref: { type: "branch", name: "main", sha: "abc1234" },
          remote_url: "https://github.com/laurigates/comfyui-touch-resize",
          dirty: false,
          enabled: true,
        },
      ],
    };
  });

  it("mounts a non-empty modal with all four tabs and loads installed packs", async () => {
    openManager();
    await flush();
    await flush();

    const tabLabels = [...document.querySelectorAll("button")].map((b) => b.textContent);
    for (const label of ["Installed", "Install URL", "Registry", "Core"]) {
      expect(tabLabels).toContain(label);
    }
    // The Updates tab is gone — folded into the Installed list.
    expect(tabLabels).not.toContain("Updates");

    // Backend is actually wired: config (gating) + installed (initial tab).
    expect(__fetchCalls.some((u) => u.includes("/touch_manager/config"))).toBe(true);
    expect(__fetchCalls.some((u) => u.includes("/touch_manager/installed"))).toBe(true);

    // Loaded data painted into the body — not an empty shell.
    expect(document.body.textContent).toContain("comfyui-touch-resize");
  });

  it("shows a Restart button on the Core tab and posts to /reboot when reboot is allowed", async () => {
    __responses["/touch_manager/core"] = {
      ok: true,
      is_git: true,
      ref: { type: "branch", name: "master", sha: "abc1234" },
      behind: { origin: 0, upstream: 0 },
      dirty: false,
      remotes: { origin: "https://github.com/comfyanonymous/ComfyUI", upstream: null },
    };
    openManager();
    await flush();
    await flush();

    // Switch to the Core tab.
    const coreTab = [...document.querySelectorAll("button")].find((b) => b.textContent === "Core");
    coreTab?.click();
    await flush();
    await flush();

    const restartBtn = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Restart ComfyUI",
    );
    expect(restartBtn).toBeTruthy();

    restartBtn?.click();
    await flush();

    // The confirmation is drawn IN-MODAL via the kit's confirmInShell (not
    // ComfyUI's PrimeVue dialog, which renders behind our z-index-9999 shell).
    // Confirm it appears on top and click its confirm button (danger variant).
    const overlay = document.querySelector(".cmp-ov-backdrop");
    expect(overlay).toBeTruthy();
    overlay.querySelector(".cmp-ov-danger").click();
    await flush();
    await flush();

    expect(__fetchCalls.some((u) => u.includes("/touch_manager/reboot"))).toBe(true);
  });

  it("stays on the Installed list after an update — refreshed in place, no result panel", async () => {
    __responses["/touch_manager/update"] = {
      ok: true,
      name: "comfyui-touch-resize",
      before_short: "abc1234",
      after_short: "def5678",
      commits_applied: 2,
      commit_log: [
        { sha: "def5678", subject: "feat: add thing" },
        { sha: "0001abc", subject: "fix: bug" },
      ],
      changed_files: 3,
      deps_changed: true,
      deps: {
        attempted: true,
        ok: true,
        sources: ["requirements.txt"],
        error: null,
        log: "Successfully installed numpy",
      },
      truncated: false,
    };
    openManager();
    await flush();
    await flush();

    const installedFetches = () =>
      __fetchCalls.filter((u) => u.includes("/touch_manager/installed")).length;
    const fetchesBefore = installedFetches();

    // Update the pack from its Installed row.
    const updateBtn = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Update",
    );
    updateBtn?.click();
    for (let i = 0; i < 4; i++) await flush();

    expect(__fetchCalls.some((u) => u.endsWith("/touch_manager/update"))).toBe(true);
    // No transition: still the Installed list (row + Update button present),
    // re-fetched in place so the row shows the new ref — no back affordance.
    expect(installedFetches()).toBe(fetchesBefore + 1);
    const buttons = [...document.querySelectorAll("button")];
    expect(buttons.some((b) => b.textContent === "Update")).toBe(true);
    expect(buttons.some((b) => b.textContent?.startsWith("← Back"))).toBe(false);
    expect(document.body.textContent).not.toContain("Applied commits");
    // The restart notice surfaces in place, and the toast carries the update
    // summary plus the dependency-install source.
    expect(document.body.textContent).toContain("Restart ComfyUI to apply");
    expect(document.body.textContent).toMatch(/requirements\.txt/);
  });

  it("lazily loads available-update info into the Installed rows in the background", async () => {
    // Two installed git packs; one has an update, the other is current.
    __responses["/touch_manager/installed"] = {
      ok: true,
      packs: [gitPack("pack-a"), gitPack("pack-b")],
    };
    __responses["/touch_manager/updates/list"] = {
      ok: true,
      packs: [{ name: "pack-a" }, { name: "pack-b" }],
    };
    __responses["/touch_manager/updates/check?name=pack-a"] = {
      ok: true,
      name: "pack-a",
      update_available: true,
      behind: 1,
      ahead: 0,
      error: null,
      incoming: [{ sha: "abc1234", subject: "feat: streamed change" }],
    };
    __responses["/touch_manager/updates/check?name=pack-b"] = {
      ok: true,
      name: "pack-b",
      update_available: false,
      behind: 0,
      ahead: 0,
      error: null,
      incoming: [],
    };
    openManager();
    // The list paints instantly, then the sweep fetches list + per-pack checks.
    for (let i = 0; i < 10; i++) await flush();

    // The list is up front — no explicit "Check for updates" click needed.
    expect(__fetchCalls.some((u) => u.includes("/touch_manager/updates/list"))).toBe(true);
    const checks = __fetchCalls.filter((u) => u.includes("/touch_manager/updates/check"));
    expect(checks.length).toBe(2); // one per listed git pack

    // The available update landed inside pack-a's row, with the incoming commit.
    expect(document.body.textContent).toContain("update available");
    expect(document.body.textContent).toContain("feat: streamed change");
    // Exactly one pack is flagged as having an update; the header counts it.
    expect(document.querySelectorAll(".tm-has-update").length).toBe(1);
    expect(document.body.textContent).toContain("1 update available");
  });

  it("searches the registry and installs a chosen version with source badges", async () => {
    __responses["/touch_manager/registry/search"] = {
      ok: true,
      page: 1,
      total_pages: 1,
      nodes: [
        {
          id: "comfyui-foo",
          name: "Foo Node",
          description: "does foo things",
          author: "octocat",
          downloads: 1500,
          icon: "",
          repository: "https://github.com/octocat/comfyui-foo",
          latest_version: "1.2.0",
          publisher: "octocat",
        },
      ],
    };
    __responses["/touch_manager/registry/versions"] = {
      ok: true,
      id: "comfyui-foo",
      versions: [{ version: "1.2.0", deprecated: false }],
    };
    __responses["/touch_manager/registry/install"] = {
      ok: true,
      name: "comfyui-foo",
      version: "1.2.0",
      source: "registry",
      deps_changed: false,
    };
    openManager();
    await flush();
    await flush();

    // Open the Registry tab and search.
    [...document.querySelectorAll("button")].find((b) => b.textContent === "Registry")?.click();
    await flush();
    [...document.querySelectorAll("button")].find((b) => b.textContent === "Search")?.click();
    for (let i = 0; i < 4; i++) await flush();

    expect(__fetchCalls.some((u) => u.includes("/touch_manager/registry/search"))).toBe(true);
    expect(document.body.textContent).toContain("Foo Node");

    // Open the version picker for the result.
    [...document.querySelectorAll("button")].find((b) => b.textContent === "Versions")?.click();
    for (let i = 0; i < 4; i++) await flush();

    expect(__fetchCalls.some((u) => u.includes("/touch_manager/registry/versions"))).toBe(true);
    // Both source badges appear: the repo git option + the registry version.
    expect(document.body.textContent).toContain("git");
    expect(document.body.textContent).toContain("registry");

    // Install the registry version — then confirm via the in-modal overlay.
    [...document.querySelectorAll("button")].find((b) => b.textContent === "Install")?.click();
    await flush();
    document.querySelector(".cmp-ov-backdrop .cmp-ov-primary").click();
    for (let i = 0; i < 4; i++) await flush();

    expect(__fetchCalls.some((u) => u.includes("/touch_manager/registry/install"))).toBe(true);
  });

  it("hides the Restart button when the backend disallows reboot", async () => {
    __responses["/touch_manager/config"].reboot_allowed = false;
    __responses["/touch_manager/core"] = {
      ok: true,
      is_git: true,
      ref: { type: "branch", name: "master", sha: "abc1234" },
      behind: { origin: 0, upstream: 0 },
      dirty: false,
      remotes: { origin: null, upstream: null },
    };
    openManager();
    await flush();
    await flush();

    const coreTab = [...document.querySelectorAll("button")].find((b) => b.textContent === "Core");
    coreTab?.click();
    await flush();
    await flush();

    const restartBtn = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Restart ComfyUI",
    );
    expect(restartBtn).toBeFalsy();
  });

  // ----- in-modal confirmation (the restart-behind-modal fix) -----

  it("cancelling the in-modal confirm does NOT restart and removes the overlay", async () => {
    __responses["/touch_manager/core"] = {
      ok: true,
      is_git: true,
      ref: { type: "branch", name: "master", sha: "abc1234" },
      behind: { origin: 0, upstream: 0 },
      dirty: false,
      remotes: { origin: null, upstream: null },
    };
    openManager();
    await flush();
    await flush();

    [...document.querySelectorAll("button")].find((b) => b.textContent === "Core")?.click();
    await flush();
    await flush();

    [...document.querySelectorAll("button")]
      .find((b) => b.textContent === "Restart ComfyUI")
      ?.click();
    await flush();

    const overlay = document.querySelector(".cmp-ov-backdrop");
    expect(overlay).toBeTruthy();
    // The confirm is mounted inside the shell dialog (z-index 9999), not via the
    // PrimeVue dialog that would render behind it.
    expect(document.querySelector(".cmp-dialog")?.contains(overlay)).toBe(true);

    [...overlay.querySelectorAll("button")].find((b) => b.textContent === "Cancel").click();
    await flush();

    expect(document.querySelector(".cmp-ov-backdrop")).toBeFalsy();
    expect(__fetchCalls.some((u) => u.includes("/touch_manager/reboot"))).toBe(false);
  });

  // ----- background update sweep: caching, filtering, in-place update -----

  // Two installed git packs, both with an available update, wired for the
  // background sweep the Installed tab kicks off on open.
  const seedTwoUpdates = () => {
    __responses["/touch_manager/installed"] = {
      ok: true,
      packs: [gitPack("pack-alpha"), gitPack("pack-beta")],
    };
    __responses["/touch_manager/updates/list"] = {
      ok: true,
      packs: [{ name: "pack-alpha" }, { name: "pack-beta" }],
    };
    __responses["/touch_manager/updates/check?name=pack-alpha"] = {
      ok: true,
      name: "pack-alpha",
      update_available: true,
      behind: 2,
      ahead: 0,
      error: null,
      incoming: [{ sha: "aaa1111", subject: "alpha change" }],
    };
    __responses["/touch_manager/updates/check?name=pack-beta"] = {
      ok: true,
      name: "pack-beta",
      update_available: true,
      behind: 1,
      ahead: 0,
      error: null,
      incoming: [{ sha: "bbb2222", subject: "beta change" }],
    };
  };

  const openInstalledAndSweep = async () => {
    openManager();
    for (let i = 0; i < 10; i++) await flush();
  };

  it("caches the sweep — leaving and re-entering Installed does not re-check", async () => {
    seedTwoUpdates();
    await openInstalledAndSweep();

    const checksAfterFirst = __fetchCalls.filter((u) =>
      u.includes("/touch_manager/updates/check"),
    ).length;
    expect(checksAfterFirst).toBe(2);
    expect(document.body.textContent).toContain("pack-alpha");
    // A finished sweep offers a Re-check affordance + an updates-available count.
    expect(
      [...document.querySelectorAll("button")].some((b) => b.textContent === "Re-check updates"),
    ).toBe(true);
    expect(document.body.textContent).toContain("2 updates available");

    // Switch away and back.
    [...document.querySelectorAll("button")].find((b) => b.textContent === "Install URL")?.click();
    for (let i = 0; i < 4; i++) await flush();
    [...document.querySelectorAll("button")].find((b) => b.textContent === "Installed")?.click();
    for (let i = 0; i < 4; i++) await flush();

    // No new per-pack checks — the cached results repaint into the rows instead.
    const checksAfterReturn = __fetchCalls.filter((u) =>
      u.includes("/touch_manager/updates/check"),
    ).length;
    expect(checksAfterReturn).toBe(2);
    expect(document.body.textContent).toContain("2 updates available");
    expect(document.querySelectorAll(".tm-has-update").length).toBe(2);
  });

  it("filters the Installed list by pack name", async () => {
    seedTwoUpdates();
    await openInstalledAndSweep();
    expect(document.body.textContent).toContain("pack-alpha");
    expect(document.body.textContent).toContain("pack-beta");

    const search = document.querySelector(".cmp-search");
    search.value = "alpha";
    search.dispatchEvent(new Event("input"));
    await flush();

    const list = document.querySelector(".tm-list");
    expect(list.textContent).toContain("pack-alpha");
    expect(list.textContent).not.toContain("pack-beta");
  });

  it("updating a pack from its row clears its update badge in place — no re-sweep", async () => {
    seedTwoUpdates();
    __responses["/touch_manager/update"] = {
      ok: true,
      name: "pack-alpha",
      before_short: "aaa1111",
      after_short: "ccc3333",
      commits_applied: 1,
      commit_log: [{ sha: "ccc3333", subject: "alpha change" }],
      changed_files: 1,
      deps_changed: false,
      truncated: false,
    };
    await openInstalledAndSweep();
    expect(document.querySelectorAll(".tm-has-update").length).toBe(2);

    const checksBefore = __fetchCalls.filter((u) =>
      u.includes("/touch_manager/updates/check"),
    ).length;

    // Update pack-alpha from its row (the emphasized Update button on its row).
    const alphaRow = [...document.querySelectorAll(".tm-row")].find((r) =>
      r.textContent.includes("pack-alpha"),
    );
    [...alphaRow.querySelectorAll("button")].find((b) => b.textContent === "Update")?.click();
    for (let i = 0; i < 6; i++) await flush();

    expect(__fetchCalls.some((u) => u.endsWith("/touch_manager/update"))).toBe(true);
    // No transition: the list refreshes in place — no Back affordance.
    expect(
      [...document.querySelectorAll("button")].some((b) => b.textContent?.startsWith("← Back")),
    ).toBe(false);
    // pack-alpha's badge is gone (it is now at its target); pack-beta keeps its.
    expect(document.querySelectorAll(".tm-has-update").length).toBe(1);
    expect(document.body.textContent).toContain("1 update available");
    const betaRow = [...document.querySelectorAll(".tm-row")].find((r) =>
      r.textContent.includes("pack-beta"),
    );
    expect(betaRow.classList.contains("tm-has-update")).toBe(true);

    // And no fresh sweep — the cached results were reused (just the one pack dropped).
    const checksAfter = __fetchCalls.filter((u) =>
      u.includes("/touch_manager/updates/check"),
    ).length;
    expect(checksAfter).toBe(checksBefore);
    // The restart notice surfaces without leaving the list.
    expect(document.body.textContent).toContain("Restart ComfyUI to apply");
  });

  // ----- hoist packs with updates to the top -----

  it("hoists packs with an available update above the rest once the sweep finishes", async () => {
    // "aaa" sorts first alphabetically but is current; "zzz" sorts last but has
    // an update — after the sweep it should be hoisted to the top.
    __responses["/touch_manager/installed"] = {
      ok: true,
      packs: [gitPack("aaa"), gitPack("zzz")],
    };
    __responses["/touch_manager/updates/list"] = {
      ok: true,
      packs: [{ name: "aaa" }, { name: "zzz" }],
    };
    __responses["/touch_manager/updates/check?name=aaa"] = {
      ok: true,
      name: "aaa",
      update_available: false,
      behind: 0,
      ahead: 0,
      error: null,
      incoming: [],
    };
    __responses["/touch_manager/updates/check?name=zzz"] = {
      ok: true,
      name: "zzz",
      update_available: true,
      behind: 1,
      ahead: 0,
      error: null,
      incoming: [],
    };
    openManager();
    for (let i = 0; i < 12; i++) await flush();

    const titles = [...document.querySelectorAll(".tm-list .tm-row-title")].map(
      (t) => t.textContent,
    );
    expect(titles[0]).toContain("zzz"); // updatable pack floated to the top
    expect(titles[1]).toContain("aaa");
    expect(document.querySelectorAll(".tm-has-update").length).toBe(1);
  });

  // ----- enable / disable a pack -----

  it("shows Enable (and no Update/Disable) for a disabled pack and posts /enable", async () => {
    __responses["/touch_manager/installed"] = {
      ok: true,
      packs: [{ ...gitPack("off-pack"), enabled: false }],
    };
    __responses["/touch_manager/updates/list"] = { ok: true, packs: [] };
    openManager();
    for (let i = 0; i < 6; i++) await flush();

    const row = [...document.querySelectorAll(".tm-row")].find((r) =>
      r.textContent.includes("off-pack"),
    );
    const labels = [...row.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).toContain("Enable");
    expect(labels).not.toContain("Disable");
    expect(labels).not.toContain("Update");

    [...row.querySelectorAll("button")].find((b) => b.textContent === "Enable")?.click();
    for (let i = 0; i < 6; i++) await flush();
    expect(__fetchCalls.some((u) => u.includes("/touch_manager/enable"))).toBe(true);
  });

  it("Disable on an enabled pack confirms in-modal, then posts /uninstall", async () => {
    __responses["/touch_manager/installed"] = { ok: true, packs: [gitPack("on-pack")] };
    __responses["/touch_manager/updates/list"] = { ok: true, packs: [] };
    openManager();
    for (let i = 0; i < 6; i++) await flush();

    const row = [...document.querySelectorAll(".tm-row")].find((r) =>
      r.textContent.includes("on-pack"),
    );
    [...row.querySelectorAll("button")].find((b) => b.textContent === "Disable")?.click();
    await flush();

    const overlay = document.querySelector(".cmp-ov-backdrop");
    expect(overlay).toBeTruthy();
    overlay.querySelector(".cmp-ov-danger").click();
    for (let i = 0; i < 6; i++) await flush();

    expect(__fetchCalls.some((u) => u.includes("/touch_manager/uninstall"))).toBe(true);
  });

  // ----- force update on a dirty pack -----

  it("offers Force/Cancel when updating a dirty pack and posts force:true when confirmed", async () => {
    __responses["/touch_manager/installed"] = {
      ok: true,
      packs: [{ ...gitPack("dirty-pack"), dirty: true }],
    };
    __responses["/touch_manager/updates/list"] = { ok: true, packs: [] };
    __responses["/touch_manager/update"] = {
      ok: true,
      name: "dirty-pack",
      before_short: "aaa1111",
      after_short: "bbb2222",
      commits_applied: 1,
      commit_log: [],
      changed_files: 1,
      deps_changed: false,
      truncated: false,
    };
    openManager();
    for (let i = 0; i < 6; i++) await flush();

    const row = [...document.querySelectorAll(".tm-row")].find((r) =>
      r.textContent.includes("dirty-pack"),
    );
    [...row.querySelectorAll("button")].find((b) => b.textContent === "Update")?.click();
    await flush();

    // A danger Force/Cancel confirm is drawn in-modal before anything is posted.
    const overlay = document.querySelector(".cmp-ov-backdrop");
    expect(overlay).toBeTruthy();
    expect(overlay.textContent).toContain("Force update");
    expect(__fetchCalls.some((u) => u.endsWith("/touch_manager/update"))).toBe(false);

    overlay.querySelector(".cmp-ov-danger").click();
    for (let i = 0; i < 6; i++) await flush();

    expect(__fetchCalls.some((u) => u.endsWith("/touch_manager/update"))).toBe(true);
    const call = __fetchBodies.find((c) => c.url.endsWith("/touch_manager/update"));
    expect(call?.body?.force).toBe(true);
  });

  it("cancelling the dirty-pack Force prompt posts nothing", async () => {
    __responses["/touch_manager/installed"] = {
      ok: true,
      packs: [{ ...gitPack("dirty-pack"), dirty: true }],
    };
    __responses["/touch_manager/updates/list"] = { ok: true, packs: [] };
    openManager();
    for (let i = 0; i < 6; i++) await flush();

    const row = [...document.querySelectorAll(".tm-row")].find((r) =>
      r.textContent.includes("dirty-pack"),
    );
    [...row.querySelectorAll("button")].find((b) => b.textContent === "Update")?.click();
    await flush();

    const overlay = document.querySelector(".cmp-ov-backdrop");
    [...overlay.querySelectorAll("button")].find((b) => b.textContent === "Cancel")?.click();
    for (let i = 0; i < 6; i++) await flush();

    expect(__fetchCalls.some((u) => u.endsWith("/touch_manager/update"))).toBe(false);
  });

  // ----- permanent delete -----

  it("Delete confirms in-modal (no Enter shortcut) and posts /delete", async () => {
    __responses["/touch_manager/installed"] = { ok: true, packs: [gitPack("doomed-pack")] };
    __responses["/touch_manager/updates/list"] = { ok: true, packs: [] };
    openManager();
    for (let i = 0; i < 6; i++) await flush();

    const row = [...document.querySelectorAll(".tm-row")].find((r) =>
      r.textContent.includes("doomed-pack"),
    );
    [...row.querySelectorAll("button")].find((b) => b.textContent === "Delete")?.click();
    await flush();

    // Nothing is posted until the danger confirm is tapped, and the copy names
    // the reversible alternative.
    const overlay = document.querySelector(".cmp-ov-backdrop");
    expect(overlay).toBeTruthy();
    expect(overlay.textContent).toContain("CANNOT be undone");
    expect(overlay.textContent).toContain("Disable");
    expect(__fetchCalls.some((u) => u.endsWith("/touch_manager/delete"))).toBe(false);

    overlay.querySelector(".cmp-ov-danger").click();
    for (let i = 0; i < 6; i++) await flush();

    expect(__fetchCalls.some((u) => u.endsWith("/touch_manager/delete"))).toBe(true);
    const call = __fetchBodies.find((c) => c.url.endsWith("/touch_manager/delete"));
    expect(call?.body?.name).toBe("doomed-pack");
    expect(document.body.textContent).toContain("Restart ComfyUI to apply");
  });

  it("offers Delete on a disabled pack too", async () => {
    __responses["/touch_manager/installed"] = {
      ok: true,
      packs: [{ ...gitPack("off-pack"), enabled: false }],
    };
    __responses["/touch_manager/updates/list"] = { ok: true, packs: [] };
    openManager();
    for (let i = 0; i < 6; i++) await flush();

    const row = [...document.querySelectorAll(".tm-row")].find((r) =>
      r.textContent.includes("off-pack"),
    );
    const labels = [...row.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).toEqual(["Enable", "Delete"]);
  });

  it("disables Delete — visibly, with the reason — when the backend gate refuses it", async () => {
    __responses["/touch_manager/config"] = {
      ok: true,
      allow_remote_install: false,
      is_loopback: false,
      manager_enabled: false,
      reboot_allowed: false,
      delete_allowed: false,
    };
    __responses["/touch_manager/installed"] = { ok: true, packs: [gitPack("safe-pack")] };
    __responses["/touch_manager/updates/list"] = { ok: true, packs: [] };
    openManager();
    for (let i = 0; i < 6; i++) await flush();

    // Present but inert. Omitting it (the old behaviour) is why nobody could
    // tell the feature existed on a LAN-bound server.
    const deleteBtn = [...document.querySelectorAll(".tm-row button")].find(
      (b) => b.textContent === "Delete",
    );
    expect(deleteBtn).toBeTruthy();
    expect(deleteBtn.disabled).toBe(true);
    expect(
      [...document.querySelectorAll(".tm-row button")].some((b) => b.textContent === "Disable"),
    ).toBe(true); // the reversible action stays live

    // The reason is on screen, not only in a title attribute (unreachable on
    // touch), and it names the env var that turns the gate off.
    const note = document.querySelector(".tm-gate-note");
    expect(note).toBeTruthy();
    expect(note.textContent).toContain("TOUCH_MANAGER_ALLOW_REMOTE_DELETE=1");

    // And it stays inert: tapping raises no confirmation and posts nothing.
    deleteBtn.click();
    for (let i = 0; i < 4; i++) await flush();
    expect(document.querySelector(".cmp-ov-backdrop")).toBeFalsy();
    expect(__fetchCalls.some((u) => u.endsWith("/touch_manager/delete"))).toBe(false);
  });

  it("leaves Delete live and unexplained when the gate permits it", async () => {
    // The other side of the pair: with delete_allowed true (the beforeEach
    // config) the button must be enabled and the gate note absent — otherwise
    // an implementation that always disables, or always warns, would pass.
    __responses["/touch_manager/installed"] = { ok: true, packs: [gitPack("live-pack")] };
    __responses["/touch_manager/updates/list"] = { ok: true, packs: [] };
    openManager();
    for (let i = 0; i < 6; i++) await flush();

    const deleteBtn = [...document.querySelectorAll(".tm-row button")].find(
      (b) => b.textContent === "Delete",
    );
    expect(deleteBtn.disabled).toBe(false);
    expect(document.querySelector(".tm-gate-note")).toBeFalsy();
  });

  // ----- pack descriptions + node summary in the Installed rows -----

  it("renders a pack's description and node summary, and omits both when absent", async () => {
    __responses["/touch_manager/installed"] = {
      ok: true,
      packs: [
        {
          ...gitPack("described-pack"),
          description: "Tiled upscaling for very large images.",
          description_source: "pyproject",
          node_count: 12,
          node_categories: ["image", "upscaling"],
        },
        // The other side of the pair: nothing to say, nothing measured. Without
        // it, an implementation that always emits the elements would pass.
        {
          ...gitPack("bare-pack"),
          description: "",
          description_source: "",
          node_count: null,
          node_categories: [],
        },
      ],
    };
    __responses["/touch_manager/updates/list"] = { ok: true, packs: [] };
    openManager();
    for (let i = 0; i < 6; i++) await flush();

    const rowFor = (name) =>
      [...document.querySelectorAll(".tm-row")].find((r) => r.textContent.includes(name));

    const described = rowFor("described-pack");
    expect(described.querySelector(".tm-row-desc")?.textContent).toBe(
      "Tiled upscaling for very large images.",
    );
    expect(described.querySelector(".tm-row-nodes")?.textContent).toBe(
      "12 nodes · image, upscaling",
    );

    const bare = rowFor("bare-pack");
    expect(bare.querySelector(".tm-row-desc")).toBeNull();
    expect(bare.querySelector(".tm-row-nodes")).toBeNull();
  });

  it("filters the Installed list by description, not just by name", async () => {
    __responses["/touch_manager/installed"] = {
      ok: true,
      packs: [
        {
          ...gitPack("obscure-name-one"),
          description: "Nodes for interrogating booru tags from images.",
          description_source: "pyproject",
          node_count: null,
          node_categories: [],
        },
        {
          ...gitPack("obscure-name-two"),
          description: "Audio reactive animation helpers.",
          description_source: "readme",
          node_count: null,
          node_categories: [],
        },
      ],
    };
    __responses["/touch_manager/updates/list"] = { ok: true, packs: [] };
    openManager();
    for (let i = 0; i < 6; i++) await flush();

    const search = document.querySelector(".cmp-search");
    search.value = "booru";
    search.dispatchEvent(new Event("input"));
    await flush();

    // "booru" appears in NO pack name — matching it at all proves the row's
    // description reached the filter, and the exclusion proves it still filters.
    const list = document.querySelector(".tm-list");
    expect(list.textContent).toContain("obscure-name-one");
    expect(list.textContent).not.toContain("obscure-name-two");
  });

  // ----- switching to a different fork -----

  const forkRepo = (full_name, over = {}) => ({
    full_name,
    owner: full_name.split("/")[0],
    url: `https://github.com/${full_name}`,
    description: "",
    stars: 0,
    pushed_at: null,
    archived: false,
    ...over,
  });

  const openForkPicker = async () => {
    __responses["/touch_manager/installed"] = {
      ok: true,
      packs: [gitPack("comfyui-touch-resize")],
    };
    __responses["/touch_manager/updates/list"] = { ok: true, packs: [] };
    __responses["/touch_manager/forks"] = {
      ok: true,
      name: "comfyui-touch-resize",
      current: "https://github.com/laurigates/comfyui-touch-resize",
      parent: forkRepo("upstream-org/comfyui-touch-resize", { stars: 400 }),
      source: null,
      forks: [
        forkRepo("laurigates/comfyui-touch-resize", { stars: 7 }),
        forkRepo("someone/comfyui-touch-resize", { stars: 12, pushed_at: "2026-06-01T00:00:00Z" }),
      ],
    };
    openManager();
    for (let i = 0; i < 6; i++) await flush();
    [...document.querySelectorAll("button")].find((b) => b.textContent === "Forks")?.click();
    for (let i = 0; i < 6; i++) await flush();
  };

  it("opens the fork picker, marks the current remote, and lists upstream first", async () => {
    await openForkPicker();

    expect(__fetchCalls.some((u) => u.includes("/touch_manager/forks"))).toBe(true);
    expect(document.body.textContent).toContain("Forks — comfyui-touch-resize");

    const titles = [...document.querySelectorAll(".tm-list .tm-row-title")].map(
      (t) => t.textContent,
    );
    expect(titles[0]).toBe("upstream-org/comfyui-touch-resize");
    expect(titles).toContain("someone/comfyui-touch-resize");

    // The repo the pack already tracks is not offered as a switch target.
    const currentRow = [...document.querySelectorAll(".tm-row")].find((r) =>
      r.textContent.includes("laurigates/comfyui-touch-resize"),
    );
    expect(currentRow.textContent).toContain("Already tracking this repository.");
    expect([...currentRow.querySelectorAll("button")]).toHaveLength(0);
  });

  it("switches to a chosen fork: confirms, posts /remote, returns to the list", async () => {
    await openForkPicker();
    __responses["/touch_manager/remote"] = {
      ok: true,
      name: "comfyui-touch-resize",
      remote_before: "https://github.com/laurigates/comfyui-touch-resize",
      remote_after: "https://github.com/upstream-org/comfyui-touch-resize",
      ref: "main",
      before_short: "abc1234",
      after_short: "def5678",
      changed_files: 4,
      deps_changed: false,
      deps: { attempted: false, ok: null, sources: [], error: null, log: "" },
    };

    const upstreamRow = [...document.querySelectorAll(".tm-row")].find((r) =>
      r.textContent.includes("upstream-org/comfyui-touch-resize"),
    );
    [...upstreamRow.querySelectorAll("button")].find((b) => b.textContent === "Switch")?.click();
    await flush();

    const overlay = document.querySelector(".cmp-ov-backdrop");
    expect(overlay).toBeTruthy();
    expect(overlay.textContent).toContain("upstream-org/comfyui-touch-resize");
    expect(__fetchCalls.some((u) => u.endsWith("/touch_manager/remote"))).toBe(false);

    overlay.querySelector(".cmp-ov-danger").click();
    for (let i = 0; i < 8; i++) await flush();

    const call = __fetchBodies.find((c) => c.url.endsWith("/touch_manager/remote"));
    expect(call?.body).toMatchObject({
      name: "comfyui-touch-resize",
      url: "https://github.com/upstream-org/comfyui-touch-resize",
    });
    expect(call?.body?.force).toBeUndefined();
    // Back on the Installed list, with the restart notice raised.
    expect(document.body.textContent).toContain("Restart ComfyUI to apply");
    expect([...document.querySelectorAll("button")].some((b) => b.textContent === "Update")).toBe(
      true,
    );
  });

  it("prompts to discard local changes before switching a dirty pack", async () => {
    __responses["/touch_manager/installed"] = {
      ok: true,
      packs: [{ ...gitPack("comfyui-touch-resize"), dirty: true }],
    };
    __responses["/touch_manager/updates/list"] = { ok: true, packs: [] };
    __responses["/touch_manager/forks"] = {
      ok: true,
      name: "comfyui-touch-resize",
      current: "https://github.com/laurigates/comfyui-touch-resize",
      parent: forkRepo("upstream-org/comfyui-touch-resize"),
      source: null,
      forks: [],
    };
    openManager();
    for (let i = 0; i < 6; i++) await flush();
    [...document.querySelectorAll("button")].find((b) => b.textContent === "Forks")?.click();
    for (let i = 0; i < 6; i++) await flush();

    [...document.querySelectorAll(".tm-row button")]
      .find((b) => b.textContent === "Switch")
      ?.click();
    await flush();
    // First confirm: the switch itself.
    document.querySelector(".cmp-ov-backdrop .cmp-ov-danger")?.click();
    await flush();
    // Second confirm: discarding the local changes — nothing posted until then.
    const overlay = document.querySelector(".cmp-ov-backdrop");
    expect(overlay.textContent).toContain("DISCARD");
    expect(__fetchCalls.some((u) => u.endsWith("/touch_manager/remote"))).toBe(false);

    overlay.querySelector(".cmp-ov-danger").click();
    for (let i = 0; i < 8; i++) await flush();
    const call = __fetchBodies.find((c) => c.url.endsWith("/touch_manager/remote"));
    expect(call?.body?.force).toBe(true);
  });

  it("keeps a paste-a-URL fallback when GitHub returns no forks", async () => {
    __responses["/touch_manager/installed"] = { ok: true, packs: [gitPack("lonely-pack")] };
    __responses["/touch_manager/updates/list"] = { ok: true, packs: [] };
    __responses["/touch_manager/forks"] = {
      ok: true,
      name: "lonely-pack",
      current: "https://gitlab.com/someone/lonely-pack",
      parent: null,
      source: null,
      forks: [],
    };
    openManager();
    for (let i = 0; i < 6; i++) await flush();
    [...document.querySelectorAll("button")].find((b) => b.textContent === "Forks")?.click();
    for (let i = 0; i < 6; i++) await flush();

    expect(document.body.textContent).toContain("No forks found");
    const urlInput = [...document.querySelectorAll("input")].find(
      (i) => i.placeholder === "https://github.com/owner/repo",
    );
    expect(urlInput).toBeTruthy();
    const manual = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Switch to this repository",
    );
    // Disabled until a valid, allowlisted URL is entered.
    expect(manual.disabled).toBe(true);
    urlInput.value = "https://github.com/other/lonely-pack";
    urlInput.dispatchEvent(new Event("input"));
    expect(manual.disabled).toBe(false);
  });

  // ----- reconnect-and-reload after a restart -----

  const coreResponse = () => ({
    ok: true,
    is_git: true,
    ref: { type: "branch", name: "master", sha: "abc1234" },
    behind: { origin: 0, upstream: 0 },
    dirty: false,
    remotes: { origin: null, upstream: null },
  });

  // Drive the modal to the Core tab and confirm a restart. Callers choose the
  // timer/advance helper via `settle` so both real- and fake-timer tests reuse
  // this. Returns after the reboot POST has fired and the watch is armed.
  const restartFromCore = async (settle) => {
    openManager();
    await settle();
    await settle();
    [...document.querySelectorAll("button")].find((b) => b.textContent === "Core")?.click();
    await settle();
    await settle();
    [...document.querySelectorAll("button")]
      .find((b) => b.textContent === "Restart ComfyUI")
      ?.click();
    await settle();
    // The restart confirm is danger-styled, drawn via the kit's confirmInShell.
    document.querySelector(".cmp-ov-backdrop .cmp-ov-danger")?.click();
    await settle();
  };

  it("shows a Restarting view with a Reload now fallback after a restart", async () => {
    __responses["/touch_manager/core"] = coreResponse();
    const flushT = () => new Promise((r) => setTimeout(r, 0));
    await restartFromCore(flushT);

    expect(__fetchCalls.some((u) => u.includes("/touch_manager/reboot"))).toBe(true);
    expect(document.body.textContent).toContain("Restarting ComfyUI…");
    expect(document.body.textContent).toContain("Waiting for ComfyUI to come back");
    // A manual reload fallback is available immediately, before any auto-reload.
    expect(
      [...document.querySelectorAll("button")].some((b) => b.textContent === "Reload now"),
    ).toBe(true);
  });

  it("polls after a restart and auto-reloads once the server answers again", async () => {
    vi.useFakeTimers();
    const reload = vi.spyOn(reloadController, "reload").mockImplementation(() => {});
    try {
      __responses["/touch_manager/core"] = coreResponse();
      const tick = () => vi.advanceTimersByTimeAsync(1);
      await restartFromCore(tick);

      expect(__fetchCalls.some((u) => u.includes("/touch_manager/reboot"))).toBe(true);
      expect(reload).not.toHaveBeenCalled();

      // The next probe (the first, after the grace delay) sees the server down…
      __fetchControl.failNext = 1;
      await vi.advanceTimersByTimeAsync(RECONNECT_POLL.graceMs + 10);
      expect(reload).not.toHaveBeenCalled();

      // …the following probe finds it back, which starts the reload countdown…
      await vi.advanceTimersByTimeAsync(RECONNECT_POLL.intervalMs + 10);
      // …and the countdown elapses to an automatic reload.
      await vi.advanceTimersByTimeAsync(RECONNECT_POLL.countdownSeconds * 1000 + 100);

      expect(reload).toHaveBeenCalled();
    } finally {
      reload.mockRestore();
      vi.useRealTimers();
    }
  });
});
