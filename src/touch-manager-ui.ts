// Touch Node Manager — the modal UI.
//
// A full-screen, touch-first node manager opened from a toolbar button or a
// command. It renders data from the /touch_manager/* backend routes into a
// tabbed modal built on @laurigates/comfy-modal-kit's `openModalShell`.
//
// Tabs: Installed (fuzzy list + per-pack Update/Versions/Uninstall),
// Updates (progressive per-pack check with live progress), Install (paste a
// github/gitlab URL — gated by the backend bind policy), Registry (search +
// install from registry.comfy.org, git or registry version), Core (core repo
// ref + behind + update). After any mutating action the modal shows a prominent
// "Restart ComfyUI to apply" notice with an optional one-tap restart (the
// backend reboot gate decides whether it is offered).
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
  formatCommitLine,
  formatCoreBehind,
  formatDepsWarning,
  formatProgress,
  formatRef,
  formatRegistryMeta,
  formatUpdateStatus,
  formatUpdateSummary,
  type InstalledPack,
  iconForKind,
  installPermitted,
  type ManagerConfig,
  mergeVersionEntries,
  partitionUpdateResults,
  type RegistryInstallResult,
  type RegistryNode,
  type RegistrySearchResult,
  type RegistryVersion,
  rebootPermitted,
  type UpdateCheckResult,
  type UpdateResult,
  type UpdatesListEntry,
  urlValidationHint,
  type VersionEntry,
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
.tm-badge { display: inline-block; font-size: 11px; font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.04em; padding: 2px 7px; border-radius: 6px; margin-right: 8px;
  border: 1px solid var(--border-color, #444); opacity: 0.85; }
.tm-badge-git { background: rgba(40,90,160,0.25); }
.tm-badge-registry { background: rgba(120,60,160,0.25); }
.tm-row-head { display: flex; align-items: center; flex-wrap: wrap; }
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

/**
 * A prominent "restart required" banner prepended to a tab body. When the
 * backend permits reboot (loopback, or the remote opt-in), it also offers a
 * one-tap "Restart now" button.
 */
function restartBanner(state: ManagerState): HTMLElement {
  const banner = el("div", "tm-restart");
  banner.appendChild(el("div", undefined, "Restart ComfyUI to apply changes."));
  if (rebootPermitted(state.config)) {
    const actions = el("div", "tm-row-actions");
    actions.appendChild(button("Restart now", "tm-btn-primary", () => void doReboot(state)));
    banner.appendChild(actions);
  }
  return banner;
}

// ============================================================
// Manager modal
// ============================================================

type TabId = "installed" | "updates" | "install" | "registry" | "core";

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
    { id: "registry", label: "Registry" },
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
    case "registry":
      return renderRegistryTab(state);
    case "core":
      return renderCoreTab(state);
  }
}

function resetBody(state: ManagerState): HTMLElement {
  const body = state.shell.bodyEl;
  body.replaceChildren();
  if (state.restartPending) body.appendChild(restartBanner(state));
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
    const result = await apiPost<UpdateResult>("update", ref ? { name, ref } : { name });
    markRestartPending(state);
    toast("success", `Updated ${name}`, formatUpdateSummary(result));
    state.shell.setBusy(false);
    renderUpdateResult(state, { ...result, name });
  } catch (e) {
    const err = e as ManagerError;
    toast("error", `Update failed: ${name}`, `${err.message}${err.code ? ` (${err.code})` : ""}`);
    state.shell.setBusy(false);
  }
}

/** A panel summarising exactly what an update applied (SHAs, commits, files). */
function renderUpdateResult(state: ManagerState, result: UpdateResult): void {
  const section = resetBody(state);
  section.appendChild(button("← Back to installed", "", () => void renderInstalledTab(state)));
  section.appendChild(el("div", "tm-row-title", `Updated ${result.name}`));
  section.appendChild(el("div", "tm-row-meta", formatUpdateSummary(result)));

  const depsWarning = formatDepsWarning(result);
  if (depsWarning) section.appendChild(el("div", "tm-note tm-note-warn", depsWarning));

  if (result.commit_log.length > 0) {
    section.appendChild(el("div", "tm-field-label", "Applied commits"));
    const list = el("div", "tm-list");
    for (const entry of result.commit_log) {
      list.appendChild(el("div", "tm-row-meta", formatCommitLine(entry)));
    }
    if (result.truncated) list.appendChild(el("div", "tm-row-meta", "…older commits omitted"));
    section.appendChild(list);
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

/** A single Updates-tab row for a pack with an available update. */
function updateRow(state: ManagerState, info: UpdateCheckResult): HTMLElement {
  const r = el("div", "tm-row");
  r.appendChild(el("div", "tm-row-title", info.name));
  r.appendChild(el("div", "tm-row-meta", formatUpdateStatus(info)));
  for (const c of info.incoming) {
    r.appendChild(el("div", "tm-row-meta", `${c.sha} ${c.subject}`));
  }
  const actions = el("div", "tm-row-actions");
  actions.appendChild(button("Update", "tm-btn-primary", () => void doUpdate(state, info.name)));
  r.appendChild(actions);
  return r;
}

// How many per-pack checks run concurrently. Small, so a long fetch can't stall
// the whole sweep while still bounding the load on the git remotes.
const UPDATE_CHECK_CONCURRENCY = 3;

/**
 * Progressive update check: fetch the git-pack names fast, then check each pack
 * one at a time (bounded concurrency), streaming rows into the list and ticking
 * a "checked N/M" progress label as results arrive.
 */
async function checkUpdates(state: ManagerState): Promise<void> {
  const section = resetBody(state);
  section.appendChild(
    button("Check for updates", "tm-btn-primary", () => void checkUpdates(state)),
  );

  let names: string[];
  try {
    const data = await apiGet<{ packs: UpdatesListEntry[] }>("updates/list");
    names = (data.packs ?? []).map((p) => p.name);
  } catch (e) {
    section.appendChild(emptyState(`Failed: ${(e as Error).message}`));
    return;
  }

  if (names.length === 0) {
    section.appendChild(emptyState("No git-backed packs to check."));
    return;
  }

  const total = names.length;
  state.shell.setStatus(formatProgress(0, total));
  const list = el("div", "tm-list");
  section.appendChild(list);
  const errors = el("div", "tm-section");

  const results: UpdateCheckResult[] = [];
  let done = 0;
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < names.length) {
      const name = names[cursor++];
      if (name === undefined) break;
      let info: UpdateCheckResult;
      try {
        info = await apiGet<UpdateCheckResult>(`updates/check?name=${encodeURIComponent(name)}`);
      } catch (e) {
        info = {
          name,
          update_available: false,
          behind: 0,
          ahead: 0,
          error: (e as Error).message,
          incoming: [],
        };
      }
      results.push(info);
      if (info.update_available && !info.error) list.appendChild(updateRow(state, info));
      else if (info.error)
        errors.appendChild(el("div", "tm-row-meta", `${info.name}: ${info.error}`));
      state.shell.setStatus(formatProgress(++done, total));
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(UPDATE_CHECK_CONCURRENCY, names.length) }, () => worker()),
  );

  const { actionable, errored } = partitionUpdateResults(results);
  if (actionable.length === 0) list.appendChild(emptyState("Everything is up to date."));
  if (errored.length > 0) {
    section.appendChild(el("div", "tm-field-label", "Could not check"));
    section.appendChild(errors);
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
// Registry tab (search + install from registry.comfy.org)
// ============================================================

async function renderRegistryTab(state: ManagerState): Promise<void> {
  const section = resetBody(state);
  section.appendChild(
    el(
      "div",
      "tm-note tm-note-info",
      "Search the Comfy Registry and install a node. Python dependencies are " +
        "NOT installed automatically — install them and restart afterwards.",
    ),
  );

  section.appendChild(el("div", "tm-field-label", "Search the registry"));
  const input = el("input", "tm-input");
  input.type = "search";
  input.placeholder = "e.g. controlnet, upscale, ipadapter…";
  input.autocomplete = "off";
  input.spellcheck = false;
  section.appendChild(input);

  const results = el("div", "tm-section");
  section.appendChild(results);

  const run = (page: number): void => void searchRegistry(state, input.value, page, results);
  input.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") run(1);
  });
  section.appendChild(button("Search", "tm-btn-primary", () => run(1)));
}

async function searchRegistry(
  state: ManagerState,
  query: string,
  page: number,
  results: HTMLElement,
): Promise<void> {
  results.replaceChildren(emptyState("Searching the registry…"));
  state.shell.setBusy(true);
  let data: RegistrySearchResult;
  try {
    data = await apiGet<RegistrySearchResult>(
      `registry/search?q=${encodeURIComponent(query)}&page=${page}`,
    );
  } catch (e) {
    results.replaceChildren(emptyState(`Registry search failed: ${(e as Error).message}`));
    return;
  } finally {
    state.shell.setBusy(false);
  }

  results.replaceChildren();
  const nodes = data.nodes ?? [];
  if (nodes.length === 0) {
    results.appendChild(emptyState("No matching nodes."));
    return;
  }

  const list = el("div", "tm-list");
  for (const node of nodes) list.appendChild(registryRow(state, node));
  results.appendChild(list);

  // Pager: prev / page indicator / next.
  const totalPages = data.total_pages ?? 1;
  if (totalPages > 1) {
    const pager = el("div", "tm-row-actions");
    const prev = button("← Prev", "", () => void searchRegistry(state, query, page - 1, results));
    prev.disabled = page <= 1;
    const next = button("Next →", "", () => void searchRegistry(state, query, page + 1, results));
    next.disabled = page >= totalPages;
    pager.appendChild(prev);
    pager.appendChild(el("div", "tm-row-meta", `Page ${page} / ${totalPages}`));
    pager.appendChild(next);
    results.appendChild(pager);
  }
}

function registryRow(state: ManagerState, node: RegistryNode): HTMLElement {
  const row = el("div", "tm-row");
  row.appendChild(el("div", "tm-row-title", node.name));
  row.appendChild(el("div", "tm-row-meta", formatRegistryMeta(node)));
  if (node.description) row.appendChild(el("div", "tm-row-meta", node.description));
  const actions = el("div", "tm-row-actions");
  actions.appendChild(
    button("Versions", "tm-btn-primary", () => void openRegistryVersions(state, node)),
  );
  row.appendChild(actions);
  return row;
}

/**
 * Unified version picker for a registry node: lists the node's registry
 * versions AND (when it has a public repo) a git option, each tagged with a
 * source badge. Picking a registry version downloads that archive; picking the
 * git option clones the repository through the existing install flow.
 */
async function openRegistryVersions(state: ManagerState, node: RegistryNode): Promise<void> {
  const section = resetBody(state);
  const back = button("← Back to registry", "", () => void renderRegistryTab(state));
  section.appendChild(back);
  section.appendChild(el("div", "tm-row-title", `Versions — ${node.name}`));
  section.appendChild(emptyState("Loading versions…"));
  state.shell.setBusy(true);

  let versions: RegistryVersion[];
  try {
    const data = await apiGet<{ versions: RegistryVersion[] }>(
      `registry/versions?id=${encodeURIComponent(node.id)}`,
    );
    versions = data.versions ?? [];
  } catch (e) {
    section.replaceChildren(
      back,
      el("div", "tm-row-title", `Versions — ${node.name}`),
      emptyState(`Failed: ${(e as Error).message}`),
    );
    state.shell.setBusy(false);
    return;
  }
  state.shell.setBusy(false);

  section.replaceChildren();
  section.appendChild(back);
  section.appendChild(el("div", "tm-row-title", `Versions — ${node.name}`));

  const entries: VersionEntry[] = mergeVersionEntries(null, versions);
  // Offer the repo's default branch as a git option when it is an allowlisted
  // git URL — this is the "git vs registry" choice the picker distinguishes.
  const repoOk = node.repository ? validateInstallUrl(node.repository).ok : false;
  if (repoOk) {
    entries.unshift({ kind: "git", label: `${node.repository} (default branch)` });
  }

  if (entries.length === 0) {
    section.appendChild(emptyState("No installable versions found."));
    return;
  }

  const list = el("div", "tm-list");
  for (const entry of entries) list.appendChild(registryVersionRow(state, node, entry));
  section.appendChild(list);
}

function registryVersionRow(
  state: ManagerState,
  node: RegistryNode,
  entry: VersionEntry,
): HTMLElement {
  const r = el("div", "tm-row");
  const head = el("div", "tm-row-head");
  const badge = el("span", `tm-badge tm-badge-${entry.kind}`, iconForKind(entry.kind));
  head.appendChild(badge);
  head.appendChild(el("span", "tm-row-title", entry.label));
  r.appendChild(head);
  if (entry.meta) r.appendChild(el("div", "tm-row-meta", entry.meta));

  const actions = el("div", "tm-row-actions");
  if (entry.kind === "git") {
    actions.appendChild(
      button("Install (git)", "tm-btn-primary", () => void doInstall(state, node.repository, "")),
    );
  } else {
    actions.appendChild(
      button(
        "Install",
        "tm-btn-primary",
        () => void doRegistryInstall(state, node, entry.version ?? null),
      ),
    );
  }
  r.appendChild(actions);
  return r;
}

async function doRegistryInstall(
  state: ManagerState,
  node: RegistryNode,
  version: string | null,
): Promise<void> {
  const label = version ? `${node.name}@${version}` : `${node.name} (latest)`;
  const ok = await confirmAction(
    "Install from registry?",
    `Download and install ${label} from the Comfy Registry into custom_nodes? ` +
      "Only install code you trust. A restart is required.",
  );
  if (!ok) return;

  state.shell.setBusy(true);
  try {
    const body: Record<string, unknown> = { id: node.id, name: node.id };
    if (version) body.version = version;
    const res = await apiPost<RegistryInstallResult>("registry/install", body);
    markRestartPending(state);
    const detail = res.deps_changed
      ? "Python dependencies changed — install them, then restart."
      : "Restart ComfyUI to apply.";
    toast("success", `Installed ${res.name}${res.version ? `@${res.version}` : ""}`, detail);
    state.shell.setBusy(false);
    await renderInstalledTab(state);
  } catch (e) {
    const err = e as ManagerError;
    toast("error", "Registry install failed", `${err.message}${err.code ? ` (${err.code})` : ""}`);
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
  if (rebootPermitted(state.config)) {
    actions.appendChild(button("Restart ComfyUI", "tm-btn-danger", () => void doReboot(state)));
  }
  section.appendChild(actions);

  section.appendChild(
    el(
      "div",
      "tm-note tm-note-info",
      "Runs git pull on the core repo. Does not install Python dependencies or restart — do those yourself after.",
    ),
  );
}

/**
 * Restart the ComfyUI server via the backend /reboot route. The process is
 * replaced by os.execv, so the POST typically never resolves (or errors as the
 * connection drops) — we treat a dropped request as "restart in progress". A
 * ManagerError means the backend refused (e.g. 403 reboot_disabled), which we
 * surface instead.
 */
async function doReboot(state: ManagerState): Promise<void> {
  const ok = await confirmAction(
    "Restart ComfyUI?",
    "Restart the ComfyUI server now to apply changes? The server will be briefly unavailable while it comes back up.",
  );
  if (!ok) return;
  toast("info", "Restarting ComfyUI…", "The server will be briefly unavailable.", 8000);
  const section = resetBody(state);
  section.appendChild(el("div", "tm-row-title", "Restarting ComfyUI…"));
  section.appendChild(
    el(
      "div",
      "tm-note tm-note-info",
      "The server is restarting. This page will reconnect once it is back; reload if it does not.",
    ),
  );
  try {
    await apiPost("reboot", {});
  } catch (e) {
    if (e instanceof ManagerError) {
      toast("error", "Restart failed", `${e.message}${e.code ? ` (${e.code})` : ""}`);
      await renderCoreTab(state);
    }
    // Otherwise the fetch dropped because the process was replaced mid-request
    // (the expected success path) — leave the "Restarting…" view in place.
  }
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
