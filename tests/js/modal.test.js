// @vitest-environment jsdom
//
// Smoke test for the modal BUILDER itself — the gap pure-helper tests miss.
// openModalShell + the tabbed body are DOM-only, so a green pure-function
// suite can coexist with an empty or unwired modal. This mounts the real
// openManager() against a jsdom document and asserts the shell renders all
// four tabs, calls the backend, and paints loaded data into the body.
import { beforeEach, describe, expect, it } from "vitest";
import { openManager } from "../../src/touch-manager-ui.ts";
import { __fetchCalls, __reset, __responses } from "./__mocks__/app.js";

// Let queued microtasks + the deferred initial load settle.
const flush = () => new Promise((r) => setTimeout(r, 0));

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
    for (const label of ["Installed", "Updates", "Install URL", "Core"]) {
      expect(tabLabels).toContain(label);
    }

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

    // The confirmation is drawn IN-MODAL (not via ComfyUI's PrimeVue dialog,
    // which renders behind our z-index-9999 shell). Confirm it appears on top
    // and click its OK button.
    const overlay = document.querySelector(".tm-confirm-overlay");
    expect(overlay).toBeTruthy();
    overlay.querySelector(".tm-confirm-ok").click();
    await flush();
    await flush();

    expect(__fetchCalls.some((u) => u.includes("/touch_manager/reboot"))).toBe(true);
  });

  it("renders an update result panel with the commit log after an update", async () => {
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
      truncated: false,
    };
    openManager();
    await flush();
    await flush();

    // Update the pack from its Installed row.
    const updateBtn = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Update",
    );
    updateBtn?.click();
    await flush();
    await flush();

    expect(__fetchCalls.some((u) => u.includes("/touch_manager/update"))).toBe(true);
    expect(document.body.textContent).toContain("feat: add thing");
    expect(document.body.textContent).toContain("fix: bug");
    // deps_changed surfaces the dependency warning.
    expect(document.body.textContent).toMatch(/requirements\.txt/);
  });

  it("streams update rows from per-pack checks on the Updates tab", async () => {
    __responses["/touch_manager/updates/list"] = {
      ok: true,
      packs: [{ name: "pack-a" }, { name: "pack-b" }],
    };
    __responses["/touch_manager/updates/check"] = {
      ok: true,
      name: "pack-a",
      update_available: true,
      behind: 1,
      ahead: 0,
      error: null,
      incoming: [{ sha: "abc1234", subject: "feat: streamed change" }],
    };
    openManager();
    await flush();
    await flush();

    const updatesTab = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Updates",
    );
    updatesTab?.click();
    await flush();

    const checkBtn = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Check for updates",
    );
    checkBtn?.click();
    // Let the list fetch + both per-pack checks settle.
    for (let i = 0; i < 6; i++) await flush();

    expect(__fetchCalls.some((u) => u.includes("/touch_manager/updates/list"))).toBe(true);
    const checks = __fetchCalls.filter((u) => u.includes("/touch_manager/updates/check"));
    expect(checks.length).toBe(2); // one per listed pack
    expect(document.body.textContent).toContain("feat: streamed change");
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
    document.querySelector(".tm-confirm-overlay .tm-confirm-ok").click();
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

    const overlay = document.querySelector(".tm-confirm-overlay");
    expect(overlay).toBeTruthy();
    // The confirm is mounted inside the shell dialog (z-index 9999), not via the
    // PrimeVue dialog that would render behind it.
    expect(document.querySelector(".cmp-dialog")?.contains(overlay)).toBe(true);

    overlay.querySelector(".tm-confirm-cancel").click();
    await flush();

    expect(document.querySelector(".tm-confirm-overlay")).toBeFalsy();
    expect(__fetchCalls.some((u) => u.includes("/touch_manager/reboot"))).toBe(false);
  });

  // ----- Updates tab: caching, filtering, scroll/back-navigation -----

  // Two distinctly-named packs, both with an available update.
  const seedTwoUpdates = () => {
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

  const openUpdatesAndCheck = async () => {
    openManager();
    await flush();
    await flush();
    [...document.querySelectorAll("button")].find((b) => b.textContent === "Updates")?.click();
    await flush();
    [...document.querySelectorAll("button")]
      .find((b) => b.textContent === "Check for updates")
      ?.click();
    for (let i = 0; i < 8; i++) await flush();
  };

  it("caches the sweep — leaving and re-entering Updates does not re-check", async () => {
    seedTwoUpdates();
    await openUpdatesAndCheck();

    const checksAfterFirst = __fetchCalls.filter((u) =>
      u.includes("/touch_manager/updates/check"),
    ).length;
    expect(checksAfterFirst).toBe(2);
    expect(document.body.textContent).toContain("pack-alpha");

    // Switch away and back.
    [...document.querySelectorAll("button")].find((b) => b.textContent === "Installed")?.click();
    for (let i = 0; i < 4; i++) await flush();
    [...document.querySelectorAll("button")].find((b) => b.textContent === "Updates")?.click();
    for (let i = 0; i < 4; i++) await flush();

    // No new per-pack checks — the cached results repaint instead.
    const checksAfterReturn = __fetchCalls.filter((u) =>
      u.includes("/touch_manager/updates/check"),
    ).length;
    expect(checksAfterReturn).toBe(2);
    expect(document.body.textContent).toContain("pack-alpha");
    // A finished sweep offers a Re-check affordance + last-checked label.
    expect([...document.querySelectorAll("button")].some((b) => b.textContent === "Re-check")).toBe(
      true,
    );
    expect(document.body.textContent).toMatch(/Last checked/);
  });

  it("filters the cached updates list by pack name", async () => {
    seedTwoUpdates();
    await openUpdatesAndCheck();
    expect(document.body.textContent).toContain("pack-alpha");
    expect(document.body.textContent).toContain("pack-beta");

    const search = document.querySelector(".cmp-search");
    search.value = "alpha";
    search.dispatchEvent(new Event("input"));
    await flush();

    const list = document.querySelector(".tm-updates-list");
    expect(list.textContent).toContain("pack-alpha");
    expect(list.textContent).not.toContain("pack-beta");
  });

  it("updating from the Updates list drops the pack and returns to the cached list", async () => {
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
    await openUpdatesAndCheck();

    const checksBefore = __fetchCalls.filter((u) =>
      u.includes("/touch_manager/updates/check"),
    ).length;

    // Update pack-alpha from its row (the first Update button in the list).
    const list = document.querySelector(".tm-updates-list");
    [...list.querySelectorAll("button")].find((b) => b.textContent === "Update")?.click();
    for (let i = 0; i < 4; i++) await flush();

    expect(__fetchCalls.some((u) => u.includes("/touch_manager/update"))).toBe(true);
    // The result panel offers a Back-to-updates affordance, not back-to-installed.
    const back = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "← Back to updates",
    );
    expect(back).toBeTruthy();

    back?.click();
    for (let i = 0; i < 4; i++) await flush();

    // Back in the cached list: no fresh sweep, and the updated pack is gone.
    const checksAfter = __fetchCalls.filter((u) =>
      u.includes("/touch_manager/updates/check"),
    ).length;
    expect(checksAfter).toBe(checksBefore);
    const list2 = document.querySelector(".tm-updates-list");
    expect(list2.textContent).not.toContain("pack-alpha");
    expect(list2.textContent).toContain("pack-beta");
  });
});
