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
});
