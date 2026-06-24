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
});
