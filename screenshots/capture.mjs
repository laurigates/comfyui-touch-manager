// Playwright driver for the README screenshot.
//
// Unlike the widget-interceptor packs, comfyui-touch-manager is an APP-LEVEL
// node manager: there's no node widget to tap. The modal is opened from the
// extension's registered command (the same function the top action-bar button
// fires), and its data comes from the /touch_manager/* backend routes rather
// than a seeded model dir. So this driver:
//
//   1. STUBS every /touch_manager/* route with page.route, returning
//      representative JSON that matches the real handler shapes in
//      touch_manager.py (config / installed / updates/list / updates/check).
//      The shot is therefore deterministic and needs no real custom_nodes,
//      git remotes, or network.
//   2. Opens the modal by invoking the pack's registered command function
//      (app.extensions[…].commands[0].function — identical to the action-bar
//      button's onClick), which calls openManager() inside the bundle.
//   3. Switches to the Updates tab, runs "Check for updates" (which the stub
//      answers instantly), and screenshots the `.cmp-dialog` showing several
//      packs with updates available + their incoming-commit previews.

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOW_PATH = resolve(HERE, "workflow.json");
const OUT_DIR = process.env.OUT_DIR || "/out";
const BASE_URL = process.env.COMFYUI_URL || "http://127.0.0.1:8188/";

// ---------------------------------------------------------------------------
// Stubbed backend state — shapes mirror the GET handlers in touch_manager.py.
// ---------------------------------------------------------------------------

const CONFIG = {
  ok: true,
  allow_remote_install: false,
  is_loopback: true,
  manager_enabled: true,
  reboot_allowed: true,
};

function ref(name, sha) {
  return { type: "branch", name, sha };
}

const INSTALLED = {
  ok: true,
  packs: [
    {
      name: "ComfyUI-Manager",
      path: "/ComfyUI/custom_nodes/ComfyUI-Manager",
      root: "/ComfyUI/custom_nodes",
      is_git: true,
      ref: ref("main", "9f3c1a2e4d77b0c1a2e4d77b0c1a2e4d77b0c1a2"),
      remote_url: "https://github.com/ltdrdata/ComfyUI-Manager",
      dirty: false,
      enabled: true,
    },
    {
      name: "comfyui-touch-manager",
      path: "/ComfyUI/custom_nodes/comfyui-touch-manager",
      root: "/ComfyUI/custom_nodes",
      is_git: true,
      ref: ref("main", "e81d7402a16c559f3c1a24b7e0d8f0a93b1c0a93"),
      remote_url: "https://github.com/laurigates/comfyui-touch-manager",
      dirty: false,
      enabled: true,
    },
    {
      name: "ComfyUI_essentials",
      path: "/ComfyUI/custom_nodes/ComfyUI_essentials",
      root: "/ComfyUI/custom_nodes",
      is_git: true,
      ref: ref("main", "7d2f9aa1c4be6005ea3f17d2f9aa1c4be6005ea3"),
      remote_url: "https://github.com/cubiq/ComfyUI_essentials",
      dirty: false,
      enabled: true,
    },
    {
      name: "comfyui-gallery-loader",
      path: "/ComfyUI/custom_nodes/comfyui-gallery-loader",
      root: "/ComfyUI/custom_nodes",
      is_git: true,
      ref: ref("main", "b3490e2f0a93b1c0a93b3490e2f0a93b1c0a93b3"),
      remote_url: "https://github.com/laurigates/comfyui-gallery-loader",
      dirty: false,
      enabled: true,
    },
  ],
};

const UPDATES_LIST = {
  ok: true,
  packs: INSTALLED.packs.map((p) => ({ name: p.name })),
};

// Per-pack update-check results (keyed by name). All have updates available so
// the Updates tab shows a populated, representative list with commit previews.
const UPDATES_CHECK = {
  "ComfyUI-Manager": {
    update_available: true,
    behind: 12,
    ahead: 0,
    error: "",
    incoming: [
      { sha: "9f3c1a2", subject: "feat: parallel update checks for large custom_nodes trees" },
      { sha: "4b7e0d8", subject: "fix: resolve tracked branch when HEAD is detached" },
      { sha: "2a16c55", subject: "chore: bump bundled dependency shims" },
    ],
  },
  "comfyui-touch-manager": {
    update_available: true,
    behind: 2,
    ahead: 0,
    error: "",
    incoming: [
      { sha: "e81d740", subject: "feat: registry search pagination" },
      { sha: "c0a93b1", subject: "fix: disable Update button on non-git packs" },
    ],
  },
  "ComfyUI_essentials": {
    update_available: true,
    behind: 5,
    ahead: 0,
    error: "",
    incoming: [
      { sha: "7d2f9aa", subject: "feat: add mask blur node" },
      { sha: "1c4be60", subject: "fix: numpy 2.0 compatibility" },
      { sha: "05ea3f1", subject: "docs: document conditioning helpers" },
    ],
  },
  "comfyui-gallery-loader": {
    update_available: true,
    behind: 1,
    ahead: 0,
    error: "",
    incoming: [{ sha: "b3490e2", subject: "feat: momentum scroll on the gallery grid" }],
  },
};

function json(route, payload) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(payload),
  });
}

async function routeTouchManager(route) {
  const url = new URL(route.request().url());
  const path = url.pathname;
  if (path.endsWith("/touch_manager/config")) return json(route, CONFIG);
  if (path.endsWith("/touch_manager/installed")) return json(route, INSTALLED);
  if (path.endsWith("/touch_manager/updates/list")) return json(route, UPDATES_LIST);
  if (path.endsWith("/touch_manager/updates/check")) {
    const name = url.searchParams.get("name") || "";
    const hit = UPDATES_CHECK[name];
    if (hit) return json(route, { ok: true, name, ...hit });
    return json(route, {
      ok: true,
      name,
      update_available: false,
      behind: 0,
      ahead: 0,
      error: "",
      incoming: [],
    });
  }
  // Anything else under the namespace: a benign ok envelope.
  return json(route, { ok: true });
}

async function dismissStartupDialog(page) {
  // A fresh ComfyUI profile opens the "Workflow Templates / Getting Started"
  // PrimeVue dialog (.p-dialog-mask) over the canvas. Close it so it doesn't
  // composite on top of our screenshot.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    for (const el of document.querySelectorAll(".p-dialog-mask")) el.remove();
  });
}

async function main() {
  const workflow = JSON.parse(await readFile(WORKFLOW_PATH, "utf8"));

  const browser = await chromium.launch({
    args: ["--font-render-hinting=none"],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  // Stub the backend BEFORE any navigation so the modal's very first fetches
  // (config on open) are answered by the stub.
  await page.route("**/touch_manager/**", routeTouchManager);

  page.on("console", (msg) => {
    const t = msg.type();
    if (t === "error" || t === "warning") {
      console.log(`[page:${t}] ${msg.text()}`);
    }
  });

  console.log(`Navigating to ${BASE_URL}…`);
  await page.goto(BASE_URL, { waitUntil: "networkidle" });

  await page.waitForFunction(
    () => window.app && window.app.graph && Array.isArray(window.app.graph._nodes),
    null,
    { timeout: 30_000 },
  );

  console.log("Loading minimal Note workflow…");
  await page.evaluate((wf) => {
    // clean=true wipes the default workflow so the canvas is just our note.
    window.app.loadGraphData(wf, true);
  }, workflow);

  await dismissStartupDialog(page);

  // Wait until the pack's extension is registered, then open the manager via
  // its registered command function — the exact same call the top action-bar
  // button's onClick fires (() => safeOpen() => openManager()).
  await page.waitForFunction(
    () => {
      const exts = window.app?.extensions;
      return Array.isArray(exts) && exts.some((e) => e?.name === "comfy.touch-manager");
    },
    null,
    { timeout: 20_000 },
  );

  console.log("Opening Touch Node Manager via the registered command…");
  const opened = await page.evaluate(() => {
    const ext = window.app.extensions.find((e) => e?.name === "comfy.touch-manager");
    if (!ext) return "no-ext";
    if (Array.isArray(ext.commands) && typeof ext.commands[0]?.function === "function") {
      ext.commands[0].function();
      return "command";
    }
    if (Array.isArray(ext.actionBarButtons) && typeof ext.actionBarButtons[0]?.onClick === "function") {
      ext.actionBarButtons[0].onClick();
      return "actionBarButton";
    }
    return "no-opener";
  });
  console.log(`Modal opener used: ${opened}`);

  const dialog = page.locator(".cmp-dialog");
  await dialog.waitFor({ state: "visible", timeout: 10_000 });

  // Switch to the Updates tab (plain DOM buttons → in-page .click() fires the
  // real listener).
  console.log("Switching to the Updates tab…");
  await page.evaluate(() => {
    const tab = [...document.querySelectorAll(".cmp-dialog .tm-tab")].find(
      (b) => b.textContent.trim() === "Updates",
    );
    tab?.click();
  });

  // Run the update check; the stub answers updates/list + each updates/check.
  console.log("Running 'Check for updates'…");
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll(".cmp-dialog button")].some(
        (b) => b.textContent.trim() === "Check for updates",
      ),
    null,
    { timeout: 8_000 },
  );
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll(".cmp-dialog button")].find(
      (b) => b.textContent.trim() === "Check for updates",
    );
    btn?.click();
  });

  // Wait for the sweep to finish: every actionable row painted and the
  // "Re-check" head button enabled (cache.complete === true).
  await page.waitForFunction(
    () => {
      const rows = document.querySelectorAll(".cmp-dialog .tm-updates-list .tm-row");
      const head = document.querySelector(".cmp-dialog .tm-updates-head button");
      return rows.length >= 4 && head && !head.disabled;
    },
    null,
    { timeout: 15_000 },
  );

  await page.waitForTimeout(400);

  console.log(`Capturing ${OUT_DIR}/manager.png…`);
  await dialog.screenshot({ path: `${OUT_DIR}/manager.png` });

  await browser.close();
}

main().catch((err) => {
  console.error("capture failed:", err);
  process.exit(1);
});
