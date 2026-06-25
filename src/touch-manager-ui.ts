// Touch Node Manager — the modal UI.
//
// A full-screen, touch-first node manager opened from a toolbar button or a
// command. It renders data from the /touch_manager/* backend routes into a
// tabbed modal built on @laurigates/comfy-modal-kit's `openModalShell`.
//
// Tabs: Installed (fuzzy list + per-pack Update/Versions/Uninstall),
// Updates (check + list packs with updates), Install (paste a github/gitlab
// URL — gated by the backend bind policy), Core (core repo ref + behind +
// update). After any mutating action the modal shows a prominent
// "Restart ComfyUI to apply" notice — it NEVER auto-restarts.
//
// All DOM lives here; the pure helpers (URL validation mirror, version-label
// formatting, fuzzy glue) come from manager-core.ts.
import {
  highlightMatches,
  type ModalShellController,
  openModalShell,
} from "@laurigates/comfy-modal-kit";
import { app } from "/scripts/app.js";
import {
  type CoreInfo,
  filterPacks,
  formatCoreBehind,
  formatRef,
  formatUpdateStatus,
  type InstalledPack,
  installPermitted,
  type ManagerConfig,
  type UpdateInfo,
  urlValidationHint,
  type VersionsInfo,
  validateInstallUrl,
  versionOptions,
} from "./manager-core";

const EXT_NAME = "comfyui-touch-manager";
const SETTING_ALLOW_REMOTE = "TouchManager.AllowRemoteInstall";

// ============================================================
// Backend access
// ============================================================

/** Error carrying the backend's `code` slug for precise surfacing. */
class ManagerError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "ManagerError";
    this.code = code;
  }
}

type OkEnvelope = { ok: boolean; error?: string; code?: string };

/** GET a /touch_manager route, parse JSON, throw ManagerError on {ok:false}. */
async function apiGet<T>(path: string): Promise<T & OkEnvelope> {
  const res = await app.api.fetchApi(app.api.apiURL(`/touch_manager/${path}`));
  const data = (await res.json()) as T & OkEnvelope;
  if (!data.ok) throw new ManagerError(data.error ?? "request failed", data.code);
  return data;
}

/** POST a JSON body to a /touch_manager route; throw ManagerError on failure. */
async function apiPost<T>(path: string, body: Record<string, unknown>): Promise<T & OkEnvelope> {
  const res = await app.api.fetchApi(app.api.apiURL(`/touch_manager/${path}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as T & OkEnvelope;
  if (!data.ok) throw new ManagerError(data.error ?? "request failed", data.code);
  return data;
}

// ============================================================
// Feedback helpers (degrade gracefully if extensionManager absent)
// ============================================================

function hasExtMgr(): boolean {
  // app.extensionManager is recent; guard so the pack degrades on older
  // frontends rather than throwing.
  return typeof app !== "undefined" && !!(app as { extensionManager?: unknown }).extensionManager;
}

function toast(
  severity: "success" | "info" | "warn" | "error",
  summary: string,
  detail?: string,
  life = 4000,
): void {
  try {
    if (hasExtMgr()) {
      app.extensionManager.toast.add({ severity, summary, detail, life });
    } else {
      console.info(`[${EXT_NAME}] ${severity}: ${summary}${detail ? ` — ${detail}` : ""}`);
    }
  } catch (e) {
    console.warn(`[${EXT_NAME}] toast failed`, e);
  }
}

async function confirmAction(title: string, message: string): Promise<boolean> {
  try {
    if (hasExtMgr()) {
      const ok = await app.extensionManager.dialog.confirm({ title, message });
      return ok === true;
    }
  } catch (e) {
    console.warn(`[${EXT_NAME}] confirm failed`, e);
  }
  // No dialog service: fall back to the browser confirm so destructive actions
  // still gate.
  return typeof window !== "undefined" && typeof window.confirm === "function"
    ? window.confirm(`${title}\n\n${message}`)
    : false;
}

// ============================================================
// Small DOM builders
// ============================================================

const STYLE_ID = "touch-manager-style";

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  // Big tap targets, 16px inputs (avoid iOS zoom), momentum scroll. Scoped
  // under .tm-* so it cannot collide with the kit's .cmp-* shell styles.
  s.textContent = `
.tm-tabs { display: flex; gap: 6px; flex-wrap: wrap; }
.tm-tab { flex: 1 1 auto; min-width: 84px; min-height: 44px; padding: 10px 12px;
  font-size: 15px; border-radius: 8px; border: 1px solid var(--border-color, #444);
  background: var(--comfy-input-bg, #222); color: inherit; cursor: pointer; }
.tm-tab.tm-active { background: var(--p-primary-color, #2b6cb0); color: #fff; border-color: transparent; }
.tm-list { display: flex; flex-direction: column; gap: 8px; -webkit-overflow-scrolling: touch; }
.tm-row { display: flex; flex-direction: column; gap: 6px; padding: 12px;
  border: 1px solid var(--border-color, #444); border-radius: 10px; background: var(--comfy-menu-bg, #1e1e1e); }
.tm-row-title { font-size: 16px; font-weight: 600; word-break: break-word; }
.tm-row-meta { font-size: 13px; opacity: 0.75; word-break: break-word; }
.tm-row-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 4px; }
.tm-btn { min-height: 44px; padding: 8px 14px; font-size: 15px; border-radius: 8px;
  border: 1px solid var(--border-color, #444); background: var(--comfy-input-bg, #2a2a2a);
  color: inherit; cursor: pointer; }
.tm-btn:disabled { opacity: 0.4; cursor: default; }
.tm-btn-danger { border-color: #a33; }
.tm-btn-primary { background: var(--p-primary-color, #2b6cb0); color: #fff; border-color: transparent; }
.tm-input { width: 100%; box-sizing: border-box; min-height: 44px; padding: 10px 12px;
  font-size: 16px; border-radius: 8px; border: 1px solid var(--border-color, #444);
  background: var(--comfy-input-bg, #222); color: inherit; }
.tm-note { font-size: 13px; padding: 10px 12px; border-radius: 8px; line-height: 1.4; }
.tm-note-warn { background: rgba(180,140,20,0.18); border: 1px solid rgba(180,140,20,0.5); }
.tm-note-info { background: rgba(40,90,160,0.18); border: 1px solid rgba(40,90,160,0.5); }
.tm-restart { background: rgba(180,140,20,0.22); border: 1px solid rgba(200,150,20,0.7);
  padding: 12px; border-radius: 10px; font-size: 15px; font-weight: 600; margin-bottom: 10px; }
.tm-empty { opacity: 0.7; font-size: 14px; padding: 16px 4px; text-align: center; }
.tm-field-label { font-size: 13px; opacity: 0.8; margin-bottom: 4px; }
.tm-section { display: flex; flex-direction: column; gap: 10px; }
.cmp-match { text-decoration: underline; }
`;
  document.head.appendChild(s);
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", `tm-btn ${className}`, label);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

function emptyState(message: string): HTMLElement {
  return el("div", "tm-empty", message);
}

/** A prominent "restart required" banner prepended to a tab body. */
function restartBanner(): HTMLElement {
  return el("div", "tm-restart", "Restart ComfyUI to apply changes.");
}

// ============================================================
// Manager modal
// ============================================================

type TabId = "installed" | "updates" | "install" | "core";

interface ManagerState {
  shell: ModalShellController;
  config: ManagerConfig | null;
  installed: InstalledPack[];
  activeTab: TabId;
  restartPending: boolean;
}

/** Open the Touch Node Manager modal. Safe to call repeatedly. */
export function openManager(): void {
  try {
    ensureStyle();
  } catch (e) {
    console.warn(`[${EXT_NAME}] style injection failed`, e);
  }

  const shell = openModalShell({
    title: "Node Manager",
    subtitle: "touch",
    placeholder: "Filter installed packs…",
    showSearch: true,
    showFooter: false,
    width: "min(720px, 96vw)",
    height: "92vh",
  });

  const state: ManagerState = {
    shell,
    config: null,
    installed: [],
    activeTab: "installed",
    restartPending: false,
  };

  // Tab bar lives in the shell toolbar row.
  const tabBar = el("div", "tm-tabs");
  const tabs: Array<{ id: TabId; label: string }> = [
    { id: "installed", label: "Installed" },
    { id: "updates", label: "Updates" },
    { id: "install", label: "Install URL" },
    { id: "core", label: "Core" },
  ];
  const tabButtons = new Map<TabId, HTMLButtonElement>();
  for (const t of tabs) {
    const b = el("button", "tm-tab", t.label);
    b.type = "button";
    b.addEventListener("click", () => selectTab(t.id));
    tabButtons.set(t.id, b);
    tabBar.appendChild(b);
  }
  shell.toolbarEl.appendChild(tabBar);

  function setSearchVisible(visible: boolean): void {
    const row = shell.searchEl.parentElement;
    if (row) row.style.display = visible ? "" : "none";
  }

  function selectTab(id: TabId): void {
    state.activeTab = id;
    for (const [tid, b] of tabButtons) b.classList.toggle("tm-active", tid === id);
    setSearchVisible(id === "installed");
    shell.setStatus("");
    void renderActiveTab(state, id);
  }

  // Wire the shell search to re-render the Installed list.
  shell.searchEl.addEventListener("input", () => {
    if (state.activeTab === "installed") renderInstalledList(state);
  });

  // Initial load: config drives the Install tab gating.
  void (async () => {
    try {
      state.config = await apiGet<ManagerConfig>("config");
    } catch (e) {
      console.warn(`[${EXT_NAME}] config load failed`, e);
      state.config = null;
    }
    selectTab("installed");
  })();
}

// ============================================================
// Tab routing
// ============================================================

async function renderActiveTab(state: ManagerState, id: TabId): Promise<void> {
  switch (id) {
    case "installed":
      return renderInstalledTab(state);
    case "updates":
      return renderUpdatesTab(state);
    case "install":
      return renderInstallTab(state);
    case "core":
      return renderCoreTab(state);
  }
}

function resetBody(state: ManagerState): HTMLElement {
  const body = state.shell.bodyEl;
  body.replaceChildren();
  if (state.restartPending) body.appendChild(restartBanner());
  const section = el("div", "tm-section");
  body.appendChild(section);
  return section;
}

function markRestartPending(state: ManagerState): void {
  state.restartPending = true;
}

// ============================================================
// Installed tab
// ============================================================

async function renderInstalledTab(state: ManagerState): Promise<void> {
  const section = resetBody(state);
  section.appendChild(emptyState("Loading installed packs…"));
  state.shell.setBusy(true);
  try {
    const data = await apiGet<{ packs: InstalledPack[] }>("installed");
    state.installed = data.packs ?? [];
  } catch (e) {
    state.installed = [];
    section.replaceChildren(emptyState(`Failed to load: ${(e as Error).message}`));
    return;
  } finally {
    state.shell.setBusy(false);
  }
  renderInstalledList(state);
}

function renderInstalledList(state: ManagerState): void {
  const section = resetBody(state);
  const query = state.shell.searchEl.value;
  const ranked = filterPacks(query, state.installed);
  state.shell.setStatus(`${ranked.length}/${state.installed.length}`);

  if (ranked.length === 0) {
    section.appendChild(
      emptyState(state.installed.length === 0 ? "No packs found." : "No matches."),
    );
    return;
  }

  const list = el("div", "tm-list");
  for (const { pack, primaryMatches } of ranked) {
    list.appendChild(installedRow(state, pack, primaryMatches));
  }
  section.appendChild(list);
}

function installedRow(state: ManagerState, pack: InstalledPack, matches: number[]): HTMLElement {
  const row = el("div", "tm-row");

  const title = el("div", "tm-row-title");
  title.appendChild(highlightMatches(pack.name, matches));
  if (!pack.enabled) {
    const tag = el("span", "tm-row-meta", "  (disabled)");
    title.appendChild(tag);
  }
  row.appendChild(title);

  const metaBits: string[] = [];
  if (pack.is_git) metaBits.push(formatRef(pack.ref));
  else metaBits.push("not a git repo");
  if (pack.dirty) metaBits.push("local changes");
  row.appendChild(el("div", "tm-row-meta", metaBits.join(" · ")));
  if (pack.remote_url) row.appendChild(el("div", "tm-row-meta", pack.remote_url));

  const actions = el("div", "tm-row-actions");
  const gitDisabledReason = pack.is_git ? "" : "not a git repo";

  const updateBtn = button("Update", "", () => void doUpdate(state, pack.name));
  updateBtn.disabled = !pack.is_git;
  if (gitDisabledReason) updateBtn.title = gitDisabledReason;
  actions.appendChild(updateBtn);

  const versionsBtn = button("Versions", "", () => void openVersions(state, pack));
  versionsBtn.disabled = !pack.is_git;
  if (gitDisabledReason) versionsBtn.title = gitDisabledReason;
  actions.appendChild(versionsBtn);

  if (pack.enabled) {
    actions.appendChild(
      button("Uninstall", "tm-btn-danger", () => void doUninstall(state, pack.name)),
    );
  }

  row.appendChild(actions);
  return row;
}

async function doUpdate(state: ManagerState, name: string, ref?: string): Promise<void> {
  state.shell.setBusy(true);
  try {
    await apiPost("update", ref ? { name, ref } : { name });
    markRestartPending(state);
    toast("success", `Updated ${name}`, "Restart ComfyUI to apply.");
    await renderInstalledTab(state);
  } catch (e) {
    const err = e as ManagerError;
    toast("error", `Update failed: ${name}`, `${err.message}${err.code ? ` (${err.code})` : ""}`);
  } finally {
    state.shell.setBusy(false);
  }
}

async function doUninstall(state: ManagerState, name: string): Promise<void> {
  const ok = await confirmAction(
    "Disable pack?",
    `Disable "${name}"? The directory is renamed to "${name}.disabled" (reversible), not deleted. A restart is required.`,
  );
  if (!ok) return;
  state.shell.setBusy(true);
  try {
    await apiPost("uninstall", { name });
    markRestartPending(state);
    toast("success", `Disabled ${name}`, "Restart ComfyUI to apply.");
    await renderInstalledTab(state);
  } catch (e) {
    const err = e as ManagerError;
    toast(
      "error",
      `Uninstall failed: ${name}`,
      `${err.message}${err.code ? ` (${err.code})` : ""}`,
    );
  } finally {
    state.shell.setBusy(false);
  }
}

// ============================================================
// Versions picker (opened from an Installed row)
// ============================================================

async function openVersions(state: ManagerState, pack: InstalledPack): Promise<void> {
  const section = resetBody(state);
  const back = button("← Back to installed", "", () => void renderInstalledTab(state));
  section.appendChild(back);
  section.appendChild(el("div", "tm-row-title", `Versions — ${pack.name}`));
  section.appendChild(emptyState("Loading versions…"));
  state.shell.setBusy(true);

  let info: VersionsInfo;
  try {
    info = await apiGet<VersionsInfo>(`versions?name=${encodeURIComponent(pack.name)}`);
  } catch (e) {
    section.replaceChildren(
      back,
      el("div", "tm-row-title", `Versions — ${pack.name}`),
      emptyState(`Failed: ${(e as Error).message}`),
    );
    state.shell.setBusy(false);
    return;
  }
  state.shell.setBusy(false);

  section.replaceChildren();
  section.appendChild(back);
  section.appendChild(el("div", "tm-row-title", `Versions — ${pack.name}`));

  const refs = versionOptions(info);
  if (refs.length === 0 && info.releases.length === 0) {
    section.appendChild(emptyState("No branches, tags, or releases found."));
    return;
  }

  if (refs.length > 0) {
    section.appendChild(el("div", "tm-field-label", "Branches & tags"));
    const list = el("div", "tm-list");
    for (const ref of refs) {
      const r = el("div", "tm-row");
      r.appendChild(el("div", "tm-row-title", ref));
      const actions = el("div", "tm-row-actions");
      actions.appendChild(
        button("Checkout", "tm-btn-primary", () => void doUpdate(state, pack.name, ref)),
      );
      r.appendChild(actions);
      list.appendChild(r);
    }
    section.appendChild(list);
  }

  if (info.releases.length > 0) {
    section.appendChild(el("div", "tm-field-label", "GitHub releases"));
    const list = el("div", "tm-list");
    for (const rel of info.releases) {
      const r = el("div", "tm-row");
      r.appendChild(el("div", "tm-row-title", rel.name || rel.tag));
      const meta: string[] = [rel.tag];
      if (rel.prerelease) meta.push("prerelease");
      if (rel.published_at) meta.push(rel.published_at);
      r.appendChild(el("div", "tm-row-meta", meta.join(" · ")));
      const actions = el("div", "tm-row-actions");
      actions.appendChild(
        button("Checkout", "tm-btn-primary", () => void doUpdate(state, pack.name, rel.tag)),
      );
      r.appendChild(actions);
      list.appendChild(r);
    }
    section.appendChild(list);
  }
}

// ============================================================
// Updates tab
// ============================================================

async function renderUpdatesTab(state: ManagerState): Promise<void> {
  const section = resetBody(state);
  section.appendChild(
    button("Check for updates", "tm-btn-primary", () => void checkUpdates(state)),
  );
  section.appendChild(
    el(
      "div",
      "tm-note tm-note-info",
      "Fetches each git pack's remote and compares against the tracked branch.",
    ),
  );
}

async function checkUpdates(state: ManagerState): Promise<void> {
  const section = resetBody(state);
  section.appendChild(
    button("Check for updates", "tm-btn-primary", () => void checkUpdates(state)),
  );
  const loading = emptyState("Checking… (git fetch per pack, may take a moment)");
  section.appendChild(loading);
  state.shell.setBusy(true);
  let updates: UpdateInfo[];
  try {
    const data = await apiGet<{ packs: UpdateInfo[] }>("updates");
    updates = data.packs ?? [];
  } catch (e) {
    loading.remove();
    section.appendChild(emptyState(`Failed: ${(e as Error).message}`));
    state.shell.setBusy(false);
    return;
  } finally {
    state.shell.setBusy(false);
  }
  loading.remove();

  const actionable = updates.filter((u) => u.update_available);
  const errored = updates.filter((u) => u.error);

  if (actionable.length === 0) {
    section.appendChild(emptyState("Everything is up to date."));
  } else {
    const list = el("div", "tm-list");
    for (const u of actionable) {
      const r = el("div", "tm-row");
      r.appendChild(el("div", "tm-row-title", u.name));
      r.appendChild(el("div", "tm-row-meta", formatUpdateStatus(u)));
      const actions = el("div", "tm-row-actions");
      actions.appendChild(button("Update", "tm-btn-primary", () => void doUpdate(state, u.name)));
      r.appendChild(actions);
      list.appendChild(r);
    }
    section.appendChild(list);
  }

  if (errored.length > 0) {
    section.appendChild(el("div", "tm-field-label", "Could not check"));
    for (const u of errored) {
      section.appendChild(el("div", "tm-row-meta", `${u.name}: ${u.error}`));
    }
  }
}

// ============================================================
// Install-from-URL tab
// ============================================================

async function renderInstallTab(state: ManagerState): Promise<void> {
  const section = resetBody(state);
  const cfg = state.config;
  const settingAllow = readAllowRemoteSetting();

  // Blocked only when the backend would refuse the clone: a non-loopback bind
  // without the override. On loopback, install is permitted. The backend is the
  // real gate; this mirrors it (see installPermitted).
  const blocked = !installPermitted(cfg);

  if (cfg && !cfg.is_loopback) {
    section.appendChild(
      el(
        "div",
        "tm-note tm-note-warn",
        blocked
          ? "ComfyUI is bound to a non-loopback address. Install from URL is disabled on the server (set TOUCH_MANAGER_ALLOW_REMOTE_INSTALL=1 to allow)."
          : "ComfyUI is bound to a non-loopback address but remote install is explicitly allowed. Only install repositories you trust.",
      ),
    );
  } else {
    section.appendChild(
      el(
        "div",
        "tm-note tm-note-info",
        "Clones a github.com or gitlab.com repository into custom_nodes. A restart is required to load it. Only install code you trust.",
      ),
    );
  }

  section.appendChild(el("div", "tm-field-label", "Repository URL"));
  const input = el("input", "tm-input");
  input.type = "url";
  input.placeholder = "https://github.com/owner/repo";
  input.autocomplete = "off";
  input.spellcheck = false;
  section.appendChild(input);

  section.appendChild(el("div", "tm-field-label", "Ref (optional branch / tag)"));
  const refInput = el("input", "tm-input");
  refInput.type = "text";
  refInput.placeholder = "leave empty for default branch";
  refInput.autocomplete = "off";
  refInput.spellcheck = false;
  section.appendChild(refInput);

  const hint = el("div", "tm-row-meta", "");
  section.appendChild(hint);

  const installBtn = button(
    "Install",
    "tm-btn-primary",
    () => void doInstall(state, input.value, refInput.value),
  );
  section.appendChild(installBtn);

  const refresh = (): void => {
    if (blocked) {
      installBtn.disabled = true;
      hint.textContent = "Install is disabled by the server bind policy.";
      return;
    }
    const v = validateInstallUrl(input.value);
    if (v.ok) {
      installBtn.disabled = false;
      hint.textContent = `Will install as "${v.name}".`;
    } else {
      installBtn.disabled = true;
      hint.textContent = input.value.trim() ? urlValidationHint(v.reason) : "";
    }
  };
  input.addEventListener("input", refresh);
  if (settingAllow && cfg && !cfg.is_loopback && blocked) {
    // The user's informational setting says allow, but the server still blocks
    // (env not set). Surface that the server decides.
    section.appendChild(
      el(
        "div",
        "tm-row-meta",
        "Your local setting allows remote install, but the server has not enabled it.",
      ),
    );
  }
  refresh();
}

function readAllowRemoteSetting(): boolean {
  try {
    if (hasExtMgr()) {
      return app.extensionManager.setting.get<boolean>(SETTING_ALLOW_REMOTE) === true;
    }
  } catch (e) {
    console.warn(`[${EXT_NAME}] setting read failed`, e);
  }
  return false;
}

async function doInstall(state: ManagerState, url: string, ref: string): Promise<void> {
  const v = validateInstallUrl(url);
  if (!v.ok) {
    toast("warn", "Invalid URL", urlValidationHint(v.reason));
    return;
  }
  const ok = await confirmAction(
    "Install pack?",
    `Clone ${url.trim()} into custom_nodes as "${v.name}"? Only install code you trust. A restart is required.`,
  );
  if (!ok) return;

  state.shell.setBusy(true);
  try {
    const body: Record<string, unknown> = { url: url.trim() };
    if (ref.trim()) body.ref = ref.trim();
    const res = await apiPost<{ name: string }>("install", body);
    markRestartPending(state);
    toast("success", `Installed ${res.name}`, "Restart ComfyUI to apply.");
    // Refresh installed list and switch to it.
    await renderInstalledTab(state);
  } catch (e) {
    const err = e as ManagerError;
    toast("error", "Install failed", `${err.message}${err.code ? ` (${err.code})` : ""}`);
  } finally {
    state.shell.setBusy(false);
  }
}

// ============================================================
// Core tab
// ============================================================

async function renderCoreTab(state: ManagerState): Promise<void> {
  const section = resetBody(state);
  section.appendChild(emptyState("Loading core repo info…"));
  state.shell.setBusy(true);
  let info: CoreInfo;
  try {
    info = await apiGet<CoreInfo>("core");
  } catch (e) {
    section.replaceChildren(emptyState(`Failed: ${(e as Error).message}`));
    state.shell.setBusy(false);
    return;
  }
  state.shell.setBusy(false);

  section.replaceChildren();
  section.appendChild(el("div", "tm-row-title", "ComfyUI core"));

  if (!info.is_git) {
    section.appendChild(
      el(
        "div",
        "tm-note tm-note-warn",
        "Core is not a git checkout — it cannot be updated from here.",
      ),
    );
    return;
  }

  const row = el("div", "tm-row");
  row.appendChild(el("div", "tm-row-meta", `Ref: ${formatRef(info.ref)}`));
  row.appendChild(el("div", "tm-row-meta", formatCoreBehind(info.behind)));
  if (info.dirty) row.appendChild(el("div", "tm-row-meta", "Working tree has local changes."));
  if (info.remotes.origin)
    row.appendChild(el("div", "tm-row-meta", `origin: ${info.remotes.origin}`));
  if (info.remotes.upstream)
    row.appendChild(el("div", "tm-row-meta", `upstream: ${info.remotes.upstream}`));
  section.appendChild(row);

  const actions = el("div", "tm-row-actions");
  actions.appendChild(button("Update core", "tm-btn-primary", () => void doCoreUpdate(state)));
  section.appendChild(actions);

  section.appendChild(
    el(
      "div",
      "tm-note tm-note-info",
      "Runs git pull on the core repo. Does not install Python dependencies or restart — do those yourself after.",
    ),
  );
}

async function doCoreUpdate(state: ManagerState): Promise<void> {
  const ok = await confirmAction(
    "Update ComfyUI core?",
    "Run git pull on the core repo? Python dependencies are NOT installed automatically and a manual restart is required.",
  );
  if (!ok) return;
  state.shell.setBusy(true);
  try {
    const res = await apiPost<{ deps_changed: boolean }>("core/update", {});
    markRestartPending(state);
    const detail = res.deps_changed
      ? "requirements.txt changed — reinstall deps, then restart."
      : "Restart ComfyUI to apply.";
    toast("success", "Core updated", detail);
    await renderCoreTab(state);
  } catch (e) {
    const err = e as ManagerError;
    toast("error", "Core update failed", `${err.message}${err.code ? ` (${err.code})` : ""}`);
  } finally {
    state.shell.setBusy(false);
  }
}
