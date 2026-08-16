// Touch Node Manager — the modal UI.
//
// A full-screen, touch-first node manager opened from a toolbar button or a
// command. It renders data from the /touch_manager/* backend routes into a
// tabbed modal built on @laurigates/comfy-modal-kit's `openModalShell`.
//
// Tabs: Installed (fuzzy list + per-pack Update/Versions/Disable, or Enable for
// a disabled pack; the list paints instantly, packs with an available update
// float to the top, and a background sweep lazily fills each git pack's
// available-update info into its row), Install (paste a github/gitlab URL —
// gated by the backend bind policy), Registry (search + install from
// registry.comfy.org, git or registry version), Core (core repo
// ref + behind + update). After any mutating action the modal shows a prominent
// "Restart ComfyUI to apply" notice with an optional one-tap restart (the
// backend reboot gate decides whether it is offered).
//
// All DOM lives here; the pure helpers (URL validation mirror, version-label
// formatting, fuzzy glue) come from manager-core.ts.
import {
  confirmInShell,
  ensureStyleOnce,
  highlightMatches,
  type ModalShellController,
  notify,
  openModalShell,
} from "@laurigates/comfy-modal-kit";
import { app } from "/scripts/app.js";
import {
  buildForkEntries,
  type CoreInfo,
  type CoreUpdateResult,
  type DepsResult,
  deletePermitted,
  type ForkEntry,
  type ForksResult,
  filterPacks,
  formatCoreBehind,
  formatDepsResult,
  formatForkMeta,
  formatNodeSummary,
  formatReconnectStatus,
  formatRef,
  formatRegistryMeta,
  formatRemoteSwitchSummary,
  formatUpdateStatus,
  formatUpdateSummary,
  hoistPacksWithUpdates,
  type InstalledPack,
  type InstallResult,
  iconForKind,
  installPermitted,
  type ManagerConfig,
  mergeVersionEntries,
  partitionUpdateResults,
  RECONNECT_POLL,
  type RegistryInstallResult,
  type RegistryNode,
  type RegistrySearchResult,
  type RegistryVersion,
  type RemoteSwitchResult,
  rebootPermitted,
  reconnectExpired,
  repoLabel,
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

/**
 * Why Delete is dead, and how to change that. Names the exact env var, because
 * the alternative is the operator reading the source to find out — the backend
 * refuses /delete on a non-loopback bind unless TOUCH_MANAGER_ALLOW_REMOTE_DELETE
 * is set, and nothing in the UI used to say so.
 */
const DELETE_GATE_HINT =
  "Delete is disabled: this server is not bound to loopback. Set " +
  "TOUCH_MANAGER_ALLOW_REMOTE_DELETE=1 in the ComfyUI server environment and " +
  "restart to enable it. Disable (reversible) works either way.";

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
  life?: number,
): void {
  try {
    // notify() (from the modal kit) renders its own DOM toast so error/warn
    // notifications carry a one-tap Copy button — the message can be lifted
    // into the clipboard for a bug report instead of retyped. Omitting `life`
    // lets notify() pick the per-severity default (errors stay sticky).
    notify({ severity, summary, detail, ...(life !== undefined ? { life } : {}) });
  } catch (e) {
    console.warn(`[${EXT_NAME}] toast failed`, e);
  }
}

// Confirmations render via the kit's confirmInShell — an overlay INSIDE
// shell.dialog. Do NOT use ComfyUI's `extensionManager.dialog.confirm` here:
// that PrimeVue dialog mounts at z-index ~1100, far below the kit's 9998/9999
// backdrop — invisible and unclickable (the "Restart now does nothing" bug).

// ============================================================
// Small DOM builders
// ============================================================

const STYLE_ID = "touch-manager-style";

// Big tap targets, 16px inputs (avoid iOS zoom), momentum scroll. Scoped
// under .tm-* so it cannot collide with the kit's .cmp-* shell styles.
export const CSS = `
/* Segmented control, not four buttons. The family (comfyui-image-browser's
   .ib-tabs, comfyui-gallery-loader's .ip-tabs) draws tab selection as ONE
   bordered container holding transparent segments with a tinted active one;
   equal-weight bordered buttons are the grammar this pack uses for Update /
   Disable / Delete, which are actions rather than a choice. The segment
   sizing is deliberately NOT copied from those packs: they use
   min-height 32px, below the 44px touch floor these packs hold everywhere
   else. Container carries the border; segments must not. */
.tm-tabs { display: flex; gap: 2px; flex-wrap: wrap; align-items: center;
  border: 1px solid var(--border-color, #2a2a32); border-radius: 10px; padding: 2px;
  background: var(--comfy-input-bg, #1a1a22); }
.tm-tab { flex: 1 1 auto; min-width: 84px; min-height: 44px; padding: 10px 12px;
  font-size: 15px; border-radius: 8px; border: 0;
  background: transparent; color: inherit; opacity: 0.7; cursor: pointer;
  font-family: inherit; }
/* Tinted, not solid-filled: the segment reads as selected within the group
   rather than as a primary action sitting on top of it. */
.tm-tab.tm-active { background: rgba(43,108,176,0.32); color: inherit; opacity: 1; font-weight: 600; }
.tm-list { display: flex; flex-direction: column; gap: 8px; -webkit-overflow-scrolling: touch; }
.tm-row { display: flex; flex-direction: column; gap: 6px; padding: 12px;
  border: 1px solid var(--border-color, #444); border-radius: 10px; background: var(--comfy-menu-bg, #1e1e1e); }
.tm-row-title { font-size: 16px; font-weight: 600; word-break: break-word; }
.tm-row-meta { font-size: 13px; opacity: 0.75; word-break: break-word; }
/* Description: clamped to three lines so one verbose pack cannot push the rest
   of a 96-row list off a phone screen. -webkit-line-clamp is the only widely
   supported multi-line clamp; the max-height is the fallback where it is not. */
.tm-row-desc { font-size: 13px; opacity: 0.9; word-break: break-word; margin: 2px 0;
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3;
  overflow: hidden; max-height: 4.2em; }
.tm-row-nodes { opacity: 0.6; }
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
.tm-badge-upstream { background: rgba(40,140,90,0.25); }
.tm-badge-fork { background: rgba(90,90,110,0.25); }
.tm-badge-current { background: rgba(200,150,20,0.25); }
.tm-row-head { display: flex; align-items: center; flex-wrap: wrap; }
.tm-installed-head { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 2px; }
.tm-installed-head .tm-sweep-label { margin-left: auto; }
.tm-row.tm-has-update { border-color: rgba(200,150,20,0.7); }
.tm-update-status { display: flex; flex-direction: column; gap: 2px; }
.tm-update-status .tm-update-available { color: #e2b23a; font-weight: 600; }
.cmp-match { text-decoration: underline; }
`;

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
 * The toast detail line after an operation that may have installed dependencies.
 * A successful (or no-op) install collapses to the plain restart hint; a failed
 * install surfaces its message so the operator fixes it before restarting.
 */
function depsToastDetail(deps: DepsResult | null | undefined): string {
  const d = formatDepsResult(deps);
  if (!d) return "Restart ComfyUI to apply.";
  return d.level === "warn" ? d.text : `${d.text} Restart ComfyUI to apply.`;
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

type TabId = "installed" | "install" | "registry" | "core";

/**
 * A background update sweep, run lazily behind the Installed list. The list
 * paints instantly from /installed; this fetches each git pack's remote (bounded
 * concurrency) and fills `results` per pack name, patching the matching row in
 * place as each check lands. Held on the state so switching tabs and returning —
 * or updating ONE pack — doesn't re-fetch every remote. `token` is the identity
 * guard: a superseded worker (re-check, or a pack-set change) bails instead of
 * scribbling into a newer sweep. `complete` distinguishes in-progress from done.
 */
interface UpdatesSweep {
  token: object;
  /** Per-pack check results, keyed by pack name. */
  results: Map<string, UpdateCheckResult>;
  total: number;
  checkedAt: number;
  complete: boolean;
}

interface ManagerState {
  shell: ModalShellController;
  config: ManagerConfig | null;
  installed: InstalledPack[];
  activeTab: TabId;
  restartPending: boolean;
  /** Background update sweep, or null until it is (re)started. */
  sweep: UpdatesSweep | null;
  /** Installed-list filter text (survives tab switches). */
  search: { installed: string };
  /** Live map of pack name → its rendered row, for O(1) in-place patching. */
  rowByName: Map<string, HTMLElement>;
}

/** Open the Touch Node Manager modal. Safe to call repeatedly. */
export function openManager(): void {
  try {
    ensureStyleOnce(STYLE_ID, CSS);
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
    sweep: null,
    search: { installed: "" },
    rowByName: new Map(),
  };

  // Tab bar lives in the shell toolbar row.
  const tabBar = el("div", "tm-tabs");
  const tabs: Array<{ id: TabId; label: string }> = [
    { id: "installed", label: "Installed" },
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

  function selectTab(id: TabId): void {
    state.activeTab = id;
    for (const [tid, b] of tabButtons) b.classList.toggle("tm-active", tid === id);
    // Restore the active tab's own query into the shared search box.
    syncSearch(state);
    shell.setStatus("");
    void renderActiveTab(state, id);
  }

  // Wire the shell search to re-filter the Installed list (the only filterable tab).
  shell.searchEl.addEventListener("input", () => {
    if (state.activeTab === "installed") {
      state.search.installed = shell.searchEl.value;
      renderInstalledList(state);
    }
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

/**
 * Show the shared search row only on the Installed tab — the one filterable
 * list — and restore its query + placeholder. It stays hidden on the
 * Install/Registry/Core tabs, which have nothing to filter.
 */
function syncSearch(state: ManagerState): void {
  const onInstalled = state.activeTab === "installed";
  const row = state.shell.searchEl.parentElement;
  if (row) row.style.display = onInstalled ? "" : "none";
  if (onInstalled) {
    state.shell.searchEl.placeholder = "Filter installed packs…";
    state.shell.searchEl.value = state.search.installed;
  }
}

function markRestartPending(state: ManagerState): void {
  state.restartPending = true;
  // In-place list repaints (post-update) never pass through resetBody —
  // surface the banner immediately instead of on the next full tab render.
  const body = state.shell.bodyEl;
  if (!body.querySelector(".tm-restart")) body.prepend(restartBanner(state));
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
  // The list is up; lazily fill in each git pack's available-update info in the
  // background. Only kick a fresh sweep when there isn't one already (in-flight
  // or cached) — revisiting the tab reuses the previous results.
  if (!state.sweep) void startUpdateSweep(state);
}

function renderInstalledList(state: ManagerState): void {
  const section = resetBody(state);
  section.appendChild(installedHead(state));

  const query = state.shell.searchEl.value;
  // Fuzzy-rank (or name-sort) first, then hoist packs with a known available
  // update to the top so the actionable rows lead. The hoist reads the sweep
  // cache, so early on (before the sweep lands) it is a no-op and the list is
  // simply name-ordered; a finished sweep repaints via renderInstalledList,
  // which is when the reorder actually happens — never mid-stream, so rows do
  // not jump around under the user while checks are still arriving.
  const ranked = hoistPacksWithUpdates(
    filterPacks(query, state.installed),
    (name) => state.sweep?.results.get(name)?.update_available === true,
  );
  state.shell.setStatus(`${ranked.length}/${state.installed.length}`);

  state.rowByName = new Map();
  if (ranked.length === 0) {
    section.appendChild(
      emptyState(state.installed.length === 0 ? "No packs found." : "No matches."),
    );
    return;
  }

  const list = el("div", "tm-list");
  for (const { pack, primaryMatches } of ranked) {
    const row = installedRow(state, pack, primaryMatches);
    state.rowByName.set(pack.name, row);
    list.appendChild(row);
  }
  section.appendChild(list);
}

/**
 * The Installed-list header: a Re-check button plus a label reflecting the
 * background sweep (checking N/M, "X updates available", or "All up to date").
 */
function installedHead(state: ManagerState): HTMLElement {
  const head = el("div", "tm-installed-head");
  const sweeping = !!state.sweep && !state.sweep.complete;
  const recheck = button("Re-check updates", "", () => void startUpdateSweep(state));
  recheck.disabled = sweeping;
  head.appendChild(recheck);
  head.appendChild(el("div", "tm-row-meta tm-sweep-label", sweepLabel(state)));
  // Say once, where it is readable on a phone, why every row's Delete is dead.
  // Only after config has actually loaded — until then deletePermitted() is
  // false by default, and claiming the gate refuses would be a guess.
  if (state.config && !deletePermitted(state.config)) {
    head.appendChild(el("div", "tm-row-meta tm-gate-note", DELETE_GATE_HINT));
  }
  return head;
}

/** Short summary of the background sweep for the Installed-list header. */
function sweepLabel(state: ManagerState): string {
  const s = state.sweep;
  if (!s) return "";
  if (!s.complete) return `Checking for updates… ${s.results.size}/${s.total}`;
  const { actionable } = partitionUpdateResults([...s.results.values()]);
  if (actionable.length === 0) return "All up to date";
  return `${actionable.length} update${actionable.length === 1 ? "" : "s"} available`;
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

  // What the pack is for, read from its own files by the backend. Rendered
  // above the version/author meta because it is the line that answers the
  // question a list of 96 opaque directory names cannot.
  if (pack.description) {
    row.appendChild(el("div", "tm-row-desc", pack.description));
  }

  const metaBits: string[] = [];
  if (pack.is_git) metaBits.push(formatRef(pack.ref));
  else if (pack.source === "registry") {
    metaBits.push(`registry pack${pack.installed_version ? ` v${pack.installed_version}` : ""}`);
  } else metaBits.push("not a git repo");
  if (pack.dirty) metaBits.push("local changes");
  if (pack.author) metaBits.push(`by ${pack.author}`);
  row.appendChild(el("div", "tm-row-meta", metaBits.join(" · ")));

  // What it actually registered in THIS install — the complement to the prose,
  // and the only description-ish line that is measured rather than authored.
  const nodeSummary = formatNodeSummary(pack);
  if (nodeSummary) row.appendChild(el("div", "tm-row-meta tm-row-nodes", nodeSummary));
  if (pack.remote_url) row.appendChild(el("div", "tm-row-meta", pack.remote_url));

  // Container the background sweep fills in place once this pack is checked.
  row.appendChild(el("div", "tm-update-status"));

  const actions = el("div", "tm-row-actions");
  if (pack.enabled) {
    // Update covers git packs (fetch/checkout) and registry-installed packs
    // (re-download); the branches/tags/releases Versions picker is git-only.
    const updatable = pack.is_git || pack.source === "registry";

    const updateBtn = button(
      "Update",
      "tm-update-btn",
      () => void doUpdate(state, pack.name, { origin: "installed" }),
    );
    updateBtn.disabled = !updatable;
    if (!updatable) updateBtn.title = "not a git repo or registry-installed pack";
    actions.appendChild(updateBtn);

    const versionsBtn = button("Versions", "", () => void openVersions(state, pack));
    versionsBtn.disabled = !pack.is_git;
    if (!pack.is_git) versionsBtn.title = "not a git repo";
    actions.appendChild(versionsBtn);

    // Switching to a fork repoints the pack's git remote — git packs only (a
    // registry pack has no remote to repoint; reinstall it from the Registry tab).
    const forksBtn = button("Forks", "", () => void openForks(state, pack));
    forksBtn.disabled = !pack.is_git;
    if (!pack.is_git) forksBtn.title = "not a git repo";
    actions.appendChild(forksBtn);

    actions.appendChild(button("Disable", "tm-btn-danger", () => void doDisable(state, pack.name)));
  } else {
    // A disabled pack can't be updated (its dir is renamed aside, so the backend
    // won't resolve it) — it can only be re-enabled or deleted for good.
    actions.appendChild(button("Enable", "tm-btn-primary", () => void doEnable(state, pack.name)));
  }
  // Permanent removal, offered for enabled and disabled packs alike. When the
  // backend's delete gate would refuse it (see deletePermitted) the button is
  // rendered DISABLED rather than omitted: hiding it silently is why the
  // feature was invisible on a LAN-bound server — nothing on screen said the
  // action existed, let alone how to enable it. The header carries the reason
  // (a title attribute is unreachable on touch, and repeating it on all 96
  // rows would be noise).
  const canDelete = deletePermitted(state.config);
  const deleteBtn = button("Delete", "tm-btn-danger", () => void doDelete(state, pack));
  deleteBtn.disabled = !canDelete;
  if (!canDelete) deleteBtn.title = DELETE_GATE_HINT;
  actions.appendChild(deleteBtn);

  row.appendChild(actions);
  // Reflect any already-known (or in-progress) update info for this pack.
  applyUpdateStatus(state, row, pack);
  return row;
}

/**
 * Render the update-status portion of an Installed row from the current sweep:
 * a "checking…" hint while the sweep is still running, an "update available"
 * line (with the incoming-commit preview and an emphasized Update button) when
 * the pack is behind, a subtle "up to date" / "check failed" otherwise. Called
 * both when a row is first built and each time a background check lands.
 */
function applyUpdateStatus(state: ManagerState, row: HTMLElement, pack: InstalledPack): void {
  const status = row.querySelector<HTMLElement>(".tm-update-status");
  const updateBtn = row.querySelector<HTMLButtonElement>(".tm-update-btn");
  if (!status) return;
  status.replaceChildren();
  row.classList.remove("tm-has-update");
  updateBtn?.classList.remove("tm-btn-primary");

  if (!pack.enabled) return; // disabled packs are not swept and have no Update btn
  if (!pack.is_git && pack.source !== "registry") return; // not part of the sweep

  const info = state.sweep?.results.get(pack.name);
  if (!info) {
    // Not checked yet: show a hint only while a sweep is actually running.
    if (state.sweep && !state.sweep.complete) {
      status.appendChild(el("div", "tm-row-meta", "checking for updates…"));
    }
    return;
  }

  if (info.error) {
    status.appendChild(el("div", "tm-row-meta", `update check failed: ${info.error}`));
    return;
  }
  if (info.update_available) {
    row.classList.add("tm-has-update");
    updateBtn?.classList.add("tm-btn-primary");
    status.appendChild(el("div", "tm-row-meta tm-update-available", formatUpdateStatus(info)));
    for (const c of info.incoming) {
      status.appendChild(el("div", "tm-row-meta", `${c.sha} ${c.subject}`));
    }
    return;
  }
  // Up to date: leave the row clean. The header's count is the summary; a
  // per-row "up to date" line on every current pack would just be noise.
}

interface UpdateOptions {
  /** Branch / tag to check out instead of fast-forwarding the tracked branch. */
  ref?: string;
  /** Which list the action came from — picks what to repaint in place. */
  origin?: TabId;
  /** Discard local changes on a dirty tree so the update can proceed. */
  force?: boolean;
}

/** Drop a pack from the cached update sweep (it is now at its target). */
function removeFromUpdatesCache(state: ManagerState, name: string): void {
  state.sweep?.results.delete(name);
}

/**
 * Re-fetch the installed packs and repaint the list in place — no loading
 * placeholder, scroll preserved — so a row action refreshes the row it acted
 * on (new ref/sha) without yanking the user out of the list.
 */
async function refreshInstalledList(state: ManagerState): Promise<void> {
  const top = state.shell.bodyEl.scrollTop;
  try {
    const data = await apiGet<{ packs: InstalledPack[] }>("installed");
    state.installed = data.packs ?? [];
  } catch {
    return; // keep the current (stale) list; the next tab entry re-fetches
  }
  if (state.activeTab !== "installed") return;
  renderInstalledList(state);
  requestAnimationFrame(() => {
    state.shell.bodyEl.scrollTop = top;
  });
}

/**
 * Confirm a forced update that will discard a pack's local changes. `fromDirty`
 * distinguishes the proactive prompt (we already know the tree is dirty) from
 * the reactive one (the update was blocked, likely by local changes).
 */
function confirmForceUpdate(
  state: ManagerState,
  name: string,
  fromDirty: boolean,
): Promise<boolean> {
  return confirmInShell(state.shell, {
    title: fromDirty ? "Pack has local changes" : "Update blocked by local changes",
    message: fromDirty
      ? `"${name}" has uncommitted local changes. Updating will DISCARD them ` +
        "(git checkout -f / reset --hard; untracked files are kept). Force the update?"
      : `Updating "${name}" was blocked — the working tree likely has local changes. ` +
        "Force the update and discard them?",
    confirmLabel: "Force update",
    danger: true,
    enterConfirms: true,
  });
}

/**
 * One update attempt. Returns the backend error `code` on failure (so the caller
 * can react — notably `"checkout_failed"`, which a force retry can clear) or null
 * on success. A `checkout_failed` on a non-forced attempt is returned WITHOUT a
 * toast, since the caller offers a forced retry instead; every other failure
 * toasts here.
 */
async function attemptUpdate(
  state: ManagerState,
  name: string,
  opts: UpdateOptions,
): Promise<string | null> {
  state.shell.setBusy(true);
  try {
    const body: Record<string, unknown> = { name };
    if (opts.ref) body.ref = opts.ref;
    if (opts.force) body.force = true;
    const result = await apiPost<UpdateResult>("update", body);
    markRestartPending(state);
    // The pack is now at its target — keep the cached sweep honest so it does
    // not keep advertising an update for a pack we just updated.
    removeFromUpdatesCache(state, name);
    const deps = formatDepsResult(result.deps);
    toast(
      deps?.level === "warn" ? "warn" : "success",
      `Updated ${name}`,
      deps ? `${formatUpdateSummary(result)} — ${deps.text}` : formatUpdateSummary(result),
    );
    // Stay in the list the action came from: refresh the Installed list in
    // place (the row re-renders with its new ref and drops its update badge)
    // instead of navigating to a separate result panel. A Versions checkout has
    // no origin — the picker stays open for further checkouts.
    if (opts.origin === "installed") {
      await refreshInstalledList(state);
    }
    return null;
  } catch (e) {
    const err = e as ManagerError;
    if (err.code === "checkout_failed" && !opts.force) return "checkout_failed";
    toast("error", `Update failed: ${name}`, `${err.message}${err.code ? ` (${err.code})` : ""}`);
    return err.code ?? "error";
  } finally {
    state.shell.setBusy(false);
  }
}

/**
 * Update one pack, handling a dirty working tree by offering the user Cancel or
 * Force. A pack we already know is dirty prompts BEFORE the attempt; a
 * `checkout_failed` on a clean-looking pack (dirtied since the last listing)
 * prompts a forced retry. Force discards local changes to tracked files.
 */
async function doUpdate(
  state: ManagerState,
  name: string,
  opts: UpdateOptions = {},
): Promise<void> {
  const pack = state.installed.find((p) => p.name === name);
  let force = opts.force ?? false;
  if (!force && pack?.is_git && pack.dirty) {
    if (!(await confirmForceUpdate(state, name, true))) return; // user cancelled
    force = true;
  }

  const code = await attemptUpdate(state, name, { ...opts, force });
  // A non-forced attempt blocked by local changes: give the reactive Cancel/Force
  // choice, then retry forced if the user confirms.
  if (code === "checkout_failed" && !force) {
    if (await confirmForceUpdate(state, name, false)) {
      await attemptUpdate(state, name, { ...opts, force: true });
    }
  }
}

async function doDisable(state: ManagerState, name: string): Promise<void> {
  const ok = await confirmInShell(state.shell, {
    title: "Disable pack?",
    message: `Disable "${name}"? The directory is renamed to "${name}.disabled" (reversible — re-enable it from its row), not deleted. A restart is required.`,
    confirmLabel: "Disable",
    danger: true,
    enterConfirms: true,
  });
  if (!ok) return;
  state.shell.setBusy(true);
  try {
    await apiPost("uninstall", { name });
    markRestartPending(state);
    // The pack set changed — the cached updates sweep is now stale.
    state.sweep = null;
    toast("success", `Disabled ${name}`, "Restart ComfyUI to apply.");
    await renderInstalledTab(state);
  } catch (e) {
    const err = e as ManagerError;
    toast("error", `Disable failed: ${name}`, `${err.message}${err.code ? ` (${err.code})` : ""}`);
  } finally {
    state.shell.setBusy(false);
  }
}

/** Re-enable a disabled pack (backend drops the ``.disabled`` suffix). */
async function doEnable(state: ManagerState, name: string): Promise<void> {
  state.shell.setBusy(true);
  try {
    await apiPost("enable", { name });
    markRestartPending(state);
    // The pack set changed — the cached updates sweep is now stale (the newly
    // enabled pack should be swept on the next check).
    state.sweep = null;
    toast("success", `Enabled ${name}`, "Restart ComfyUI to apply.");
    await renderInstalledTab(state);
  } catch (e) {
    const err = e as ManagerError;
    toast("error", `Enable failed: ${name}`, `${err.message}${err.code ? ` (${err.code})` : ""}`);
  } finally {
    state.shell.setBusy(false);
  }
}

/**
 * Permanently delete a pack's directory. The confirmation spells out what is
 * lost (the directory, any local edits) and points at Disable as the reversible
 * alternative — this is the only action in the manager that cannot be undone.
 */
async function doDelete(state: ManagerState, pack: InstalledPack): Promise<void> {
  const ok = await confirmInShell(state.shell, {
    title: "Delete pack permanently?",
    message:
      `Permanently delete "${pack.name}" and everything in it, including any local ` +
      `changes? This CANNOT be undone.\n\n${pack.path}\n\n` +
      (pack.enabled
        ? "To remove it reversibly instead, cancel and use Disable. "
        : "This pack is already disabled — deleting frees its disk space. ") +
      "A restart is required.",
    confirmLabel: "Delete permanently",
    danger: true,
    // No Enter shortcut: an irreversible action should take a deliberate tap.
    enterConfirms: false,
  });
  if (!ok) return;
  state.shell.setBusy(true);
  try {
    await apiPost("delete", { name: pack.name });
    markRestartPending(state);
    // The pack set changed — the cached updates sweep is now stale.
    state.sweep = null;
    toast("success", `Deleted ${pack.name}`, "Restart ComfyUI to apply.");
    await renderInstalledTab(state);
  } catch (e) {
    const err = e as ManagerError;
    toast(
      "error",
      `Delete failed: ${pack.name}`,
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
        button("Checkout", "tm-btn-primary", () => void doUpdate(state, pack.name, { ref })),
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
        button(
          "Checkout",
          "tm-btn-primary",
          () => void doUpdate(state, pack.name, { ref: rel.tag }),
        ),
      );
      r.appendChild(actions);
      list.appendChild(r);
    }
    section.appendChild(list);
  }
}

// ============================================================
// Fork picker (opened from an Installed row)
//
// "Switch to a different fork" keeps the pack's DIRECTORY (its name is part of
// the /extensions/<pack>/ URL and of ComfyUI's module identity) and its git
// history, and only repoints origin. The list comes from the GitHub API via the
// backend — upstream first, then siblings by stars — and there is always a
// paste-a-URL fallback for a fork the API cannot enumerate (or a non-GitHub one).
// ============================================================

/** Show the fork filter input only once the list is long enough to need it. */
const FORK_FILTER_THRESHOLD = 6;

async function openForks(state: ManagerState, pack: InstalledPack): Promise<void> {
  const heading = (): HTMLElement[] => [
    button("← Back to installed", "", () => void renderInstalledTab(state)),
    el("div", "tm-row-title", `Forks — ${pack.name}`),
  ];
  const section = resetBody(state);
  section.append(...heading(), emptyState("Loading forks…"));
  state.shell.setBusy(true);

  let data: ForksResult;
  try {
    data = await apiGet<ForksResult>(`forks?name=${encodeURIComponent(pack.name)}`);
  } catch (e) {
    section.replaceChildren(...heading(), emptyState(`Failed: ${(e as Error).message}`));
    state.shell.setBusy(false);
    return;
  }
  state.shell.setBusy(false);

  // Switching lands code from another repository, so it rides the backend's
  // install bind gate — reflect that here rather than letting it fail on POST.
  const allowed = installPermitted(state.config);
  section.replaceChildren(...heading());
  section.appendChild(
    el(
      "div",
      allowed ? "tm-note tm-note-info" : "tm-note tm-note-warn",
      allowed
        ? `Switching repoints "${pack.name}" at another repository. Its directory name and ` +
            "git history are kept — only the code it tracks changes. Python dependencies are " +
            "installed automatically; a restart is required. Only switch to code you trust."
        : "ComfyUI is bound to a non-loopback address, so the server refuses to switch a " +
            "pack's repository (set TOUCH_MANAGER_ALLOW_REMOTE_INSTALL=1 to allow).",
    ),
  );

  section.appendChild(el("div", "tm-field-label", "Current remote"));
  section.appendChild(el("div", "tm-row-meta", data.current ?? "no remote configured"));

  const entries = buildForkEntries(data);
  if (entries.length === 0) {
    section.appendChild(
      emptyState(
        "No forks found — this pack is not on GitHub, has no forks, or the GitHub API is " +
          "unavailable. You can still enter a repository URL below.",
      ),
    );
  } else {
    section.appendChild(el("div", "tm-field-label", "Upstream & forks"));
    const listHost = el("div", "tm-section");
    const paint = (query: string): void => {
      listHost.replaceChildren(forkList(state, pack, entries, query, allowed));
    };
    if (entries.length >= FORK_FILTER_THRESHOLD) {
      const filter = el("input", "tm-input");
      filter.type = "search";
      filter.placeholder = "Filter forks…";
      filter.autocomplete = "off";
      filter.spellcheck = false;
      filter.addEventListener("input", () => paint(filter.value));
      section.appendChild(filter);
    }
    section.appendChild(listHost);
    paint("");
  }

  section.appendChild(el("div", "tm-field-label", "Other repository URL"));
  const urlInput = el("input", "tm-input");
  urlInput.type = "url";
  urlInput.placeholder = "https://github.com/owner/repo";
  urlInput.autocomplete = "off";
  urlInput.spellcheck = false;
  section.appendChild(urlInput);

  const refInput = el("input", "tm-input");
  refInput.type = "text";
  refInput.placeholder = "ref (optional branch / tag)";
  refInput.autocomplete = "off";
  refInput.spellcheck = false;
  section.appendChild(refInput);

  const hint = el("div", "tm-row-meta", "");
  section.appendChild(hint);
  const switchBtn = button(
    "Switch to this repository",
    "tm-btn-primary",
    () => void doSwitchRemote(state, pack, urlInput.value.trim(), refInput.value.trim()),
  );
  section.appendChild(switchBtn);

  const refresh = (): void => {
    if (!allowed) {
      switchBtn.disabled = true;
      hint.textContent = "Switching is disabled by the server bind policy.";
      return;
    }
    const v = validateInstallUrl(urlInput.value);
    switchBtn.disabled = !v.ok;
    hint.textContent = v.ok
      ? `Will track ${repoLabel(urlInput.value)}.`
      : urlInput.value.trim()
        ? urlValidationHint(v.reason)
        : "";
  };
  urlInput.addEventListener("input", refresh);
  refresh();
}

/**
 * The fork rows, fuzzy-filtered by `query`. An empty query preserves
 * buildForkEntries' deliberate order (upstream first, then stars) instead of
 * re-sorting by name, so the default view leads with the useful rows.
 */
function forkList(
  state: ManagerState,
  pack: InstalledPack,
  entries: readonly ForkEntry[],
  query: string,
  allowed: boolean,
): HTMLElement {
  const rows = entries.map((entry) => ({
    name: entry.repo.full_name,
    remote_url: entry.repo.url,
    author: entry.repo.owner,
    entry,
  }));
  const ranked = query.trim()
    ? filterPacks(query, rows)
    : rows.map((row) => ({ pack: row, primaryMatches: [] as number[] }));

  const list = el("div", "tm-list");
  if (ranked.length === 0) {
    list.appendChild(emptyState("No matching forks."));
    return list;
  }
  for (const { pack: row, primaryMatches } of ranked) {
    list.appendChild(forkRow(state, pack, row.entry, primaryMatches, allowed));
  }
  return list;
}

function forkRow(
  state: ManagerState,
  pack: InstalledPack,
  entry: ForkEntry,
  matches: number[],
  allowed: boolean,
): HTMLElement {
  const row = el("div", "tm-row");
  const head = el("div", "tm-row-head");
  head.appendChild(el("span", `tm-badge tm-badge-${entry.role}`, entry.role));
  const title = el("span", "tm-row-title");
  title.appendChild(highlightMatches(entry.repo.full_name, matches));
  head.appendChild(title);
  row.appendChild(head);
  row.appendChild(el("div", "tm-row-meta", formatForkMeta(entry.repo)));
  if (entry.repo.description) row.appendChild(el("div", "tm-row-meta", entry.repo.description));

  const actions = el("div", "tm-row-actions");
  if (entry.role === "current") {
    actions.appendChild(el("div", "tm-row-meta", "Already tracking this repository."));
  } else {
    const switchBtn = button(
      "Switch",
      "tm-btn-primary",
      () => void doSwitchRemote(state, pack, entry.repo.url),
    );
    switchBtn.disabled = !allowed;
    if (!allowed) switchBtn.title = "disabled by the server bind policy";
    actions.appendChild(switchBtn);
  }
  row.appendChild(actions);
  return row;
}

/** Confirm a fork switch that will discard the pack's local changes. */
function confirmForceSwitch(
  state: ManagerState,
  name: string,
  fromDirty: boolean,
): Promise<boolean> {
  return confirmInShell(state.shell, {
    title: fromDirty ? "Pack has local changes" : "Switch blocked by local changes",
    message: fromDirty
      ? `"${name}" has uncommitted local changes. Switching repositories will DISCARD them ` +
        "(untracked files are kept). Continue?"
      : `Switching "${name}" was refused — the working tree has local changes. ` +
        "Discard them (untracked files are kept) and switch anyway?",
    confirmLabel: "Discard and switch",
    danger: true,
    enterConfirms: true,
  });
}

/**
 * One switch attempt. Returns the backend error `code` on failure — notably
 * `"dirty"`, which the caller clears with a forced retry — or null on success.
 * A non-forced `dirty` refusal is returned WITHOUT a toast (the caller offers
 * the Force choice instead); every other failure toasts here.
 */
async function attemptRemoteSwitch(
  state: ManagerState,
  pack: InstalledPack,
  url: string,
  ref: string,
  force: boolean,
): Promise<string | null> {
  state.shell.setBusy(true);
  try {
    const body: Record<string, unknown> = { name: pack.name, url };
    if (ref) body.ref = ref;
    if (force) body.force = true;
    const result = await apiPost<RemoteSwitchResult>("remote", body);
    markRestartPending(state);
    // The pack tracks a different repo now: every cached update check for it is
    // meaningless, so drop the whole sweep and let the list re-check.
    state.sweep = null;
    const deps = formatDepsResult(result.deps);
    toast(
      deps?.level === "warn" ? "warn" : "success",
      `Switched ${pack.name}`,
      deps
        ? `${formatRemoteSwitchSummary(result)} — ${deps.text}`
        : formatRemoteSwitchSummary(result),
    );
    await renderInstalledTab(state);
    return null;
  } catch (e) {
    const err = e as ManagerError;
    if (err.code === "dirty" && !force) return "dirty";
    toast(
      "error",
      `Switch failed: ${pack.name}`,
      `${err.message}${err.code ? ` (${err.code})` : ""}`,
    );
    return err.code ?? "error";
  } finally {
    state.shell.setBusy(false);
  }
}

/**
 * Switch a pack to another repository: confirm the switch itself, then handle a
 * dirty working tree the same way an update does — prompt before the attempt
 * when we already know it is dirty, or offer a forced retry when the backend
 * refuses with `dirty`.
 */
async function doSwitchRemote(
  state: ManagerState,
  pack: InstalledPack,
  url: string,
  ref = "",
): Promise<void> {
  const target = repoLabel(url) || url;
  const ok = await confirmInShell(state.shell, {
    title: "Switch to a different fork?",
    message:
      `Point "${pack.name}" at ${target}${ref ? ` @ ${ref}` : ""}? Its directory name and git ` +
      "history are kept; the code it tracks is replaced. Only switch to code you trust. " +
      "A restart is required.",
    confirmLabel: "Switch",
    danger: true,
    enterConfirms: true,
  });
  if (!ok) return;

  let force = false;
  if (pack.dirty) {
    if (!(await confirmForceSwitch(state, pack.name, true))) return; // user cancelled
    force = true;
  }

  const code = await attemptRemoteSwitch(state, pack, url, ref, force);
  if (code === "dirty" && !force && (await confirmForceSwitch(state, pack.name, false))) {
    await attemptRemoteSwitch(state, pack, url, ref, true);
  }
}

// ============================================================
// Background update sweep (feeds the Installed list)
//
// The Installed list paints instantly from /installed; this sweep then fetches
// each git pack's remote (bounded concurrency) and fills its per-pack
// available-update info into the matching row IN PLACE — no reorder, no full
// repaint, so the list never jumps under the user. Results are cached on the
// state (keyed by pack name), so switching tabs and returning — or updating one
// pack — reuses them instead of re-fetching every remote. `sweep.token` is the
// identity guard: a superseded worker (re-check, or a pack-set change that
// nulls the sweep) bails rather than scribbling into a newer sweep.
// ============================================================

// How many per-pack checks run concurrently. Small, so a long fetch can't stall
// the whole sweep while still bounding the load on the git remotes.
const UPDATE_CHECK_CONCURRENCY = 3;

/** Repaint the Installed head (sweep label + Re-check enabled state) in place. */
function refreshSweepHead(state: ManagerState): void {
  const body = state.shell.bodyEl;
  const label = body.querySelector<HTMLElement>(".tm-sweep-label");
  if (label) label.textContent = sweepLabel(state);
  const recheck = body.querySelector<HTMLButtonElement>(".tm-installed-head .tm-btn");
  if (recheck) recheck.disabled = !!state.sweep && !state.sweep.complete;
}

/** Patch a single pack's row from the latest sweep result, if it is rendered. */
function patchRow(state: ManagerState, name: string): void {
  const row = state.rowByName.get(name);
  if (!row) return;
  const pack = state.installed.find((p) => p.name === name);
  if (pack) applyUpdateStatus(state, row, pack);
}

/**
 * Start (or restart) the background update sweep: fetch the git-pack names fast,
 * then check each pack with bounded concurrency, streaming each result into the
 * cached sweep and patching the matching Installed row as it lands. Safe to call
 * fire-and-forget; a fresh `token` supersedes any in-flight sweep.
 */
async function startUpdateSweep(state: ManagerState): Promise<void> {
  const sweep: UpdatesSweep = {
    token: {},
    results: new Map(),
    total: 0,
    checkedAt: Date.now(),
    complete: false,
  };
  state.sweep = sweep;
  if (state.activeTab === "installed") repaintUpdateStatuses(state);

  let names: string[];
  try {
    const data = await apiGet<{ packs: UpdatesListEntry[] }>("updates/list");
    names = (data.packs ?? []).map((p) => p.name);
  } catch {
    if (state.sweep !== sweep) return; // superseded
    sweep.complete = true; // give up quietly; rows keep their base info
    if (state.activeTab === "installed") refreshSweepHead(state);
    return;
  }
  if (state.sweep !== sweep) return; // superseded while listing

  sweep.total = names.length;
  if (names.length === 0) {
    sweep.complete = true;
    // No updatable packs — nothing to hoist; just refresh the "All up to date"
    // head. A full re-render would needlessly rebuild the whole list.
    if (state.activeTab === "installed") repaintUpdateStatuses(state);
    return;
  }
  // The real pack count is known now — reflect it in the header before checking.
  if (state.activeTab === "installed") refreshSweepHead(state);

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
          source: "unknown",
          update_available: false,
          behind: 0,
          ahead: 0,
          error: (e as Error).message,
          incoming: [],
          latest_version: null,
        };
      }
      if (state.sweep !== sweep) return; // a newer sweep took over
      sweep.results.set(name, info);
      if (state.activeTab === "installed") {
        patchRow(state, name);
        refreshSweepHead(state);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(UPDATE_CHECK_CONCURRENCY, names.length) }, () => worker()),
  );

  if (state.sweep !== sweep) return; // superseded
  sweep.complete = true;
  // The sweep is done: repaint the whole list so packs with an available update
  // float to the top (hoist). This is the single, predictable reorder — the
  // per-check patches above stayed in place so nothing jumped mid-stream.
  if (state.activeTab === "installed") renderInstalledList(state);
}

/** Re-apply the sweep's status to every rendered row and refresh the head. */
function repaintUpdateStatuses(state: ManagerState): void {
  for (const [name, row] of state.rowByName) {
    const pack = state.installed.find((p) => p.name === name);
    if (pack) applyUpdateStatus(state, row, pack);
  }
  refreshSweepHead(state);
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
  const ok = await confirmInShell(state.shell, {
    title: "Install pack?",
    message: `Clone ${url.trim()} into custom_nodes as "${v.name}"? Only install code you trust. A restart is required.`,
    confirmLabel: "Install",
    enterConfirms: true,
  });
  if (!ok) return;

  state.shell.setBusy(true);
  try {
    const body: Record<string, unknown> = { url: url.trim() };
    if (ref.trim()) body.ref = ref.trim();
    const res = await apiPost<InstallResult>("install", body);
    markRestartPending(state);
    state.sweep = null;
    const level = res.deps.attempted && res.deps.ok === false ? "warn" : "success";
    toast(level, `Installed ${res.name}`, depsToastDetail(res.deps));
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
        "installed automatically; a restart is required afterwards.",
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
  const ok = await confirmInShell(state.shell, {
    title: "Install from registry?",
    message:
      `Download and install ${label} from the Comfy Registry into custom_nodes? ` +
      "Only install code you trust. A restart is required.",
    confirmLabel: "Install",
    enterConfirms: true,
  });
  if (!ok) return;

  state.shell.setBusy(true);
  try {
    const body: Record<string, unknown> = { id: node.id, name: node.id };
    if (version) body.version = version;
    const res = await apiPost<RegistryInstallResult>("registry/install", body);
    markRestartPending(state);
    state.sweep = null;
    const level = res.deps.attempted && res.deps.ok === false ? "warn" : "success";
    toast(
      level,
      `Installed ${res.name}${res.version ? `@${res.version}` : ""}`,
      depsToastDetail(res.deps),
    );
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
      "Runs git pull on the core repo and installs any changed Python dependencies. Restart ComfyUI yourself afterwards.",
    ),
  );
}

// ============================================================
// Restart + reconnect-and-reload
// ============================================================

/**
 * Page reload, indirected through a mutable object so the jsdom test can spy on
 * it without stubbing `window.location` (which jsdom refuses to reload).
 */
export const reloadController = {
  reload(): void {
    window.location.reload();
  },
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Cheap "is the server answering yet?" probe against our OWN /config route.
 * A 200 proves this pack re-imported (its routes are registered again), not
 * merely that aiohttp is listening — so it is a stronger "fully back" signal
 * than the socket reopening. Any network error or non-200 is treated as "still
 * down". `no-store` avoids a cached 200 masking a still-restarting server.
 */
async function probeServer(): Promise<boolean> {
  try {
    const res = await app.api.fetchApi(app.api.apiURL("/touch_manager/config"), {
      cache: "no-store",
    });
    return res.ok === true;
  } catch {
    return false;
  }
}

/** A cancel handle so a refused reboot (403) can abort the watch mid-grace. */
interface RestartWatch {
  cancelled: boolean;
}

/**
 * Once the server is back, count down (cancelable) and then reload so the page
 * picks up the freshly-loaded nodes / bundles. A "Reload now" button reloads
 * instantly; "Cancel" stops the countdown and leaves the choice to the user.
 */
function startReloadCountdown(status: HTMLElement, actions: HTMLElement): void {
  let remaining = RECONNECT_POLL.countdownSeconds;
  let cancelled = false;
  const tick = (): void => {
    if (cancelled) return;
    if (remaining <= 0) {
      reloadController.reload();
      return;
    }
    status.textContent = `ComfyUI is back — reloading in ${remaining}…`;
    remaining -= 1;
    setTimeout(tick, 1000);
  };
  actions.replaceChildren();
  actions.appendChild(
    button("Reload now", "tm-btn-primary", () => {
      cancelled = true;
      reloadController.reload();
    }),
  );
  actions.appendChild(
    button("Cancel", "", () => {
      cancelled = true;
      status.textContent = "ComfyUI is back. Reload when you're ready.";
    }),
  );
  tick();
}

/**
 * Poll the server after a restart and auto-reload once it answers again.
 * Builds the "Restarting…" view (live status + an always-available Reload now
 * fallback), waits a grace period for os.execv to replace the process, then
 * probes on an interval until the server returns or the timeout budget is
 * spent. `watch.cancelled` lets a refused reboot abort the loop.
 */
async function watchForReconnect(state: ManagerState, watch: RestartWatch): Promise<void> {
  const section = resetBody(state);
  section.appendChild(el("div", "tm-row-title", "Restarting ComfyUI…"));
  const status = el("div", "tm-note tm-note-info", formatReconnectStatus(0));
  section.appendChild(status);
  const actions = el("div", "tm-row-actions");
  actions.appendChild(button("Reload now", "tm-btn-primary", () => reloadController.reload()));
  section.appendChild(actions);

  const start = Date.now();
  await sleep(RECONNECT_POLL.graceMs);
  while (!watch.cancelled && !reconnectExpired(Date.now() - start)) {
    if (await probeServer()) {
      if (watch.cancelled) return;
      startReloadCountdown(status, actions);
      return;
    }
    if (watch.cancelled) return;
    status.textContent = formatReconnectStatus(Date.now() - start);
    await sleep(RECONNECT_POLL.intervalMs);
  }
  if (!watch.cancelled) {
    // Timed out — the "Reload now" button is already there; update the note.
    status.textContent = formatReconnectStatus(RECONNECT_POLL.timeoutMs);
  }
}

/**
 * Restart the ComfyUI server via the backend /reboot route, then watch for it
 * to come back and reload the page. The process is replaced by os.execv, so the
 * POST typically never resolves (the connection drops) — we treat that as
 * "restart in progress" and let the reconnect watch drive recovery. A
 * ManagerError means the backend refused (e.g. 403 reboot_disabled): the server
 * did NOT restart, so we cancel the watch and surface the error instead.
 */
async function doReboot(state: ManagerState): Promise<void> {
  const ok = await confirmInShell(state.shell, {
    title: "Restart ComfyUI?",
    message:
      "Restart the ComfyUI server now to apply changes? The server will be briefly unavailable, then this page reloads automatically once it is back.",
    confirmLabel: "Restart now",
    danger: true,
    enterConfirms: true,
  });
  if (!ok) return;
  toast("info", "Restarting ComfyUI…", "The page will reload automatically once it is back.", 8000);

  // Start the reconnect watch immediately (its grace delay outlasts a fast 403
  // refusal, so a cancel below still lands before the first probe).
  const watch: RestartWatch = { cancelled: false };
  void watchForReconnect(state, watch);

  try {
    await apiPost("reboot", {});
    // A resolved POST is unusual (the process is normally gone before the
    // response) — the watch confirms the server is actually back regardless.
  } catch (e) {
    if (e instanceof ManagerError) {
      watch.cancelled = true;
      toast("error", "Restart failed", `${e.message}${e.code ? ` (${e.code})` : ""}`);
      await renderCoreTab(state);
    }
    // Otherwise the fetch dropped because the process was replaced mid-request
    // (the expected success path) — leave the reconnect watch running.
  }
}

async function doCoreUpdate(state: ManagerState): Promise<void> {
  const ok = await confirmInShell(state.shell, {
    title: "Update ComfyUI core?",
    message:
      "Run git pull on the core repo? Python dependencies are installed automatically when they change; a manual restart is required afterwards.",
    confirmLabel: "Update core",
    enterConfirms: true,
  });
  if (!ok) return;
  state.shell.setBusy(true);
  try {
    const res = await apiPost<CoreUpdateResult>("core/update", {});
    markRestartPending(state);
    const level = res.deps.attempted && res.deps.ok === false ? "warn" : "success";
    toast(level, "Core updated", depsToastDetail(res.deps));
    await renderCoreTab(state);
  } catch (e) {
    const err = e as ManagerError;
    toast("error", "Core update failed", `${err.message}${err.code ? ` (${err.code})` : ""}`);
  } finally {
    state.shell.setBusy(false);
  }
}
