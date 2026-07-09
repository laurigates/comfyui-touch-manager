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
import { __fetchCalls, __fetchControl, __reset, __responses } from "./__mocks__/app.js";

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

    expect(__fetchCalls.some((u) => u.includes("/touch_manager/update"))).toBe(true);
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

    expect(__fetchCalls.some((u) => u.includes("/touch_manager/update"))).toBe(true);
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
