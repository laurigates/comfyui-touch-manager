// src/index.ts
import { app as app2 } from "/scripts/app.js";

// node_modules/@laurigates/comfy-modal-kit/dist/index.js
function fuzzyScore(query, target) {
  if (!query)
    return { score: 0, matches: [] };
  if (!target)
    return null;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  const matches = [];
  let qi = 0;
  let score = 0;
  let consecutive = 0;
  let prevMatchIdx = -1;
  for (let ti = 0;ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) {
      consecutive = 0;
      continue;
    }
    let charScore = 1;
    if (ti === 0) {
      charScore += 5;
    } else {
      const prev = t[ti - 1];
      const orig = target[ti];
      if (prev === "_" || prev === "-" || prev === " " || prev === "." || prev === "/") {
        charScore += 4;
      } else if (prev !== undefined && prev >= "a" && prev <= "z" && orig !== undefined && orig >= "A" && orig <= "Z") {
        charScore += 3;
      }
    }
    if (ti === prevMatchIdx + 1) {
      consecutive++;
      charScore += consecutive * 2;
    } else {
      consecutive = 0;
    }
    score += charScore;
    matches.push(ti);
    prevMatchIdx = ti;
    qi++;
  }
  if (qi < q.length)
    return null;
  score -= target.length * 0.01;
  return { score, matches };
}
function fuzzyRank(query, fields, primaryWeight = 10) {
  if (!query)
    return { score: 0, primaryMatches: [] };
  const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!tokens.length)
    return { score: 0, primaryMatches: [] };
  const primary = fields[0] || "";
  const rest = fields.slice(1).filter((f) => Boolean(f));
  let totalScore = 0;
  const primaryMatchSet = new Set;
  for (const token of tokens) {
    const primaryResult = fuzzyScore(token, primary);
    let best = primaryResult ? {
      score: primaryResult.score * primaryWeight,
      matches: primaryResult.matches,
      onPrimary: true
    } : null;
    for (const field of rest) {
      const r = fuzzyScore(token, field);
      if (r && (!best || r.score > best.score)) {
        best = { score: r.score, matches: r.matches, onPrimary: false };
      }
    }
    if (!best)
      return null;
    totalScore += best.score;
    if (best.onPrimary) {
      for (const i of best.matches)
        primaryMatchSet.add(i);
    }
  }
  return {
    score: totalScore,
    primaryMatches: [...primaryMatchSet].sort((a, b) => a - b)
  };
}
function highlightMatches(target, matchIndices) {
  const frag = document.createDocumentFragment();
  if (!target)
    return frag;
  const set = new Set(matchIndices || []);
  if (!set.size) {
    frag.appendChild(document.createTextNode(target));
    return frag;
  }
  for (let i = 0;i < target.length; i++) {
    const ch = target[i];
    if (set.has(i)) {
      const m = document.createElement("span");
      m.className = "cmp-match";
      m.textContent = ch;
      frag.appendChild(m);
    } else {
      frag.appendChild(document.createTextNode(ch));
    }
  }
  return frag;
}
var STYLE_ID = "cmn-notify-style";
var CONTAINER_ID = "cmn-notify-container";
function defaultLife(severity) {
  switch (severity) {
    case "error":
      return 0;
    case "warn":
      return 8000;
    default:
      return 4000;
  }
}
function defaultCopyable(severity) {
  return severity === "error" || severity === "warn";
}
function notifyClipboardText(summary, detail) {
  return detail ? `${summary}
${detail}` : summary;
}
async function copyTextToClipboard(text) {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  try {
    if (typeof document === "undefined")
      return false;
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
var CSS = `
.cmn-container {
    position: fixed;
    top: 12px;
    right: 12px;
    z-index: 10000;
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: min(380px, calc(100vw - 24px));
    pointer-events: none;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
}
.cmn-toast {
    pointer-events: auto;
    background: #1a1a1f;
    color: #e8e8ea;
    border: 1px solid #3a3a44;
    border-left-width: 4px;
    border-radius: 8px;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.6);
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 13px;
    line-height: 1.4;
    animation: cmn-in 0.16s ease-out;
}
@keyframes cmn-in {
    from { transform: translateY(-8px); opacity: 0; }
    to   { transform: translateY(0);    opacity: 1; }
}
.cmn-toast.cmn-success { border-left-color: #4caf50; }
.cmn-toast.cmn-info    { border-left-color: #6ba6ff; }
.cmn-toast.cmn-warn    { border-left-color: #e0a83a; }
.cmn-toast.cmn-error   { border-left-color: #e0533a; }
.cmn-row {
    display: flex;
    align-items: flex-start;
    gap: 10px;
}
.cmn-text {
    flex: 1;
    min-width: 0;
    word-break: break-word;
}
.cmn-summary { font-weight: 600; }
.cmn-detail  { color: #b8b8c0; margin-top: 2px; white-space: pre-wrap; }
.cmn-close {
    background: transparent;
    color: #aaa;
    border: none;
    cursor: pointer;
    font-size: 18px;
    line-height: 1;
    padding: 0;
    width: 24px;
    height: 24px;
    flex-shrink: 0;
}
.cmn-close:hover { color: #fff; }
.cmn-actions { display: flex; gap: 8px; }
.cmn-copy {
    background: #2a2a36;
    color: #d8d8e0;
    border: 1px solid #3a3a44;
    border-radius: 5px;
    /* Touch-first: comfortable tap target, 13px text. */
    min-height: 32px;
    padding: 6px 12px;
    cursor: pointer;
    font-size: 13px;
    font-family: inherit;
    display: inline-flex;
    align-items: center;
    gap: 6px;
}
.cmn-copy:hover  { background: #34343f; color: #fff; }
.cmn-copy.cmn-copied { background: #2f4a30; border-color: #4caf50; color: #cfe8d0; }
`;
function ensureStyle() {
  if (typeof document === "undefined")
    return;
  if (document.getElementById(STYLE_ID))
    return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}
function ensureContainer() {
  let c = document.getElementById(CONTAINER_ID);
  if (!c) {
    c = document.createElement("div");
    c.id = CONTAINER_ID;
    c.className = "cmn-container";
    document.body.appendChild(c);
  }
  return c;
}
function notify(opts) {
  const { severity, summary, detail } = opts;
  if (typeof document === "undefined" || !document.body) {
    console.info(`[notify] ${severity}: ${summary}${detail ? ` — ${detail}` : ""}`);
    return null;
  }
  ensureStyle();
  const container = ensureContainer();
  const life = opts.life ?? defaultLife(severity);
  const copyable = opts.copyable ?? defaultCopyable(severity);
  const toast = document.createElement("div");
  toast.className = `cmn-toast cmn-${severity}`;
  toast.setAttribute("role", severity === "error" ? "alert" : "status");
  let timer;
  const close = () => {
    if (timer)
      clearTimeout(timer);
    toast.remove();
    if (container.childElementCount === 0)
      container.remove();
  };
  const row = document.createElement("div");
  row.className = "cmn-row";
  const text = document.createElement("div");
  text.className = "cmn-text";
  const summaryEl = document.createElement("div");
  summaryEl.className = "cmn-summary";
  summaryEl.textContent = summary;
  text.appendChild(summaryEl);
  if (detail) {
    const detailEl = document.createElement("div");
    detailEl.className = "cmn-detail";
    detailEl.textContent = detail;
    text.appendChild(detailEl);
  }
  const closeBtn = document.createElement("button");
  closeBtn.className = "cmn-close";
  closeBtn.type = "button";
  closeBtn.textContent = "×";
  closeBtn.title = "Dismiss";
  closeBtn.addEventListener("click", close);
  row.append(text, closeBtn);
  toast.appendChild(row);
  if (copyable) {
    const actions = document.createElement("div");
    actions.className = "cmn-actions";
    const copyBtn = document.createElement("button");
    copyBtn.className = "cmn-copy";
    copyBtn.type = "button";
    copyBtn.textContent = "Copy";
    copyBtn.addEventListener("click", async () => {
      const ok = await copyTextToClipboard(notifyClipboardText(summary, detail));
      copyBtn.textContent = ok ? "Copied ✓" : "Copy failed";
      copyBtn.classList.toggle("cmn-copied", ok);
      setTimeout(() => {
        copyBtn.textContent = "Copy";
        copyBtn.classList.remove("cmn-copied");
      }, 1500);
    });
    actions.appendChild(copyBtn);
    toast.appendChild(actions);
  }
  container.appendChild(toast);
  if (life > 0) {
    timer = setTimeout(close, life);
  }
  return { close, el: toast };
}
var STYLE_ID2 = "cmp-shell-style";
var ACTIVE = null;
var CSS2 = `
.cmp-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    z-index: 9998;
    backdrop-filter: blur(2px);
    touch-action: manipulation;
}
.cmp-dialog {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 9999;
    width: min(960px, calc(100vw - 24px));
    max-height: min(85vh, 800px);
    touch-action: manipulation;
    display: flex;
    flex-direction: column;
    background: #1a1a1f;
    color: #e8e8ea;
    border: 1px solid #3a3a44;
    border-radius: 10px;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.7);
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size: 13px;
    overflow: hidden;
}
.cmp-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 14px;
    border-bottom: 1px solid #2a2a32;
    background: #21212a;
    flex-shrink: 0;
}
.cmp-title {
    flex: 1;
    font-weight: 600;
    color: #9ec6ff;
    font-size: 14px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.cmp-subtitle {
    color: #888;
    font-weight: 400;
    font-size: 12px;
    margin-left: 6px;
}
.cmp-close {
    background: transparent;
    color: #aaa;
    border: 1px solid #3a3a44;
    border-radius: 4px;
    width: 36px;
    height: 36px;
    cursor: pointer;
    font-size: 20px;
    line-height: 1;
    flex-shrink: 0;
}
.cmp-close:hover {
    background: #2a2a32;
    color: #fff;
}
.cmp-toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    padding: 8px 14px;
    border-bottom: 1px solid #2a2a32;
    background: #1f1f26;
    flex-shrink: 0;
}
.cmp-toolbar:empty {
    display: none;
}
.cmp-searchrow {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
    border-bottom: 1px solid #2a2a32;
    flex-shrink: 0;
}
.cmp-search {
    flex: 1;
    background: #12121a;
    border: 1px solid #3a3a44;
    border-radius: 4px;
    color: #e8e8ea;
    padding: 8px 12px;
    /* 16px prevents iOS auto-zoom on focus. */
    font-size: 16px;
    font-family: inherit;
    outline: none;
    min-width: 0;
}
.cmp-search:focus {
    border-color: #6ba6ff;
}
.cmp-status {
    color: #888;
    font-size: 12px;
    white-space: nowrap;
}
.cmp-body {
    flex: 1;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior: contain;
    padding: 8px;
    position: relative;
}
.cmp-body.is-busy {
    opacity: 0.5;
    pointer-events: none;
}
.cmp-footer {
    padding: 8px 14px;
    border-top: 1px solid #2a2a32;
    color: #777;
    font-size: 11px;
    background: #1f1f26;
    flex-shrink: 0;
    display: flex;
    justify-content: space-between;
    gap: 12px;
}
.cmp-footer:empty {
    display: none;
}
.cmp-footer kbd {
    background: #2a2a36;
    border: 1px solid #3a3a44;
    border-bottom-width: 2px;
    border-radius: 3px;
    padding: 1px 5px;
    font-family: ui-monospace, monospace;
    font-size: 10px;
    color: #b8b8c0;
}
`;
function ensureStyle2() {
  if (document.getElementById(STYLE_ID2))
    return;
  const s = document.createElement("style");
  s.id = STYLE_ID2;
  s.textContent = CSS2;
  document.head.appendChild(s);
}
function dismissActive() {
  if (!ACTIVE)
    return;
  const a = ACTIVE;
  ACTIVE = null;
  try {
    a.backdrop.remove();
    a.dialog.remove();
    document.removeEventListener("keydown", a._onKey, true);
  } finally {
    try {
      a.opts.onClose?.();
    } catch (e) {
      console.warn("[modal-shell] onClose threw", e);
    }
  }
}
function openModalShell(opts = {}) {
  ensureStyle2();
  dismissActive();
  const backdrop = document.createElement("div");
  backdrop.className = "cmp-backdrop";
  backdrop.addEventListener("pointerdown", dismissActive);
  const dialog = document.createElement("div");
  dialog.className = "cmp-dialog";
  if (opts.width)
    dialog.style.width = opts.width;
  if (opts.height)
    dialog.style.maxHeight = opts.height;
  const stop = (e) => e.stopPropagation();
  for (const ev of ["pointerdown", "pointerup", "click", "dblclick", "wheel"]) {
    dialog.addEventListener(ev, stop);
  }
  const headerEl = document.createElement("div");
  headerEl.className = "cmp-header";
  const titleEl = document.createElement("div");
  titleEl.className = "cmp-title";
  titleEl.textContent = opts.title || "";
  if (opts.subtitle) {
    const sub = document.createElement("span");
    sub.className = "cmp-subtitle";
    sub.textContent = opts.subtitle;
    titleEl.appendChild(sub);
  }
  const closeBtn = document.createElement("button");
  closeBtn.className = "cmp-close";
  closeBtn.type = "button";
  closeBtn.textContent = "×";
  closeBtn.title = "Close (Esc)";
  closeBtn.addEventListener("click", dismissActive);
  headerEl.append(titleEl, closeBtn);
  const toolbarEl = document.createElement("div");
  toolbarEl.className = "cmp-toolbar";
  const searchRow = document.createElement("div");
  searchRow.className = "cmp-searchrow";
  const searchEl = document.createElement("input");
  searchEl.type = "search";
  searchEl.className = "cmp-search";
  searchEl.placeholder = opts.placeholder || "Filter…";
  searchEl.spellcheck = false;
  searchEl.autocomplete = "off";
  const statusEl = document.createElement("div");
  statusEl.className = "cmp-status";
  searchRow.append(searchEl, statusEl);
  if (opts.showSearch === false)
    searchRow.style.display = "none";
  const bodyEl = document.createElement("div");
  bodyEl.className = "cmp-body";
  const footerEl = document.createElement("div");
  footerEl.className = "cmp-footer";
  if (opts.showFooter !== false) {
    const l = document.createElement("div");
    if (opts.footerLeftHTML)
      l.innerHTML = opts.footerLeftHTML;
    const r = document.createElement("div");
    if (opts.footerRightHTML)
      r.innerHTML = opts.footerRightHTML;
    footerEl.append(l, r);
  } else {
    footerEl.style.display = "none";
  }
  dialog.append(headerEl, toolbarEl, searchRow, bodyEl, footerEl);
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      dismissActive();
      return;
    }
    try {
      opts.onKeyDown?.(e);
    } catch (err) {
      console.warn("[modal-shell] onKeyDown threw", err);
    }
  };
  document.addEventListener("keydown", onKey, true);
  document.body.append(backdrop, dialog);
  const controller = {
    backdrop,
    dialog,
    headerEl,
    toolbarEl,
    searchEl,
    statusEl,
    bodyEl,
    footerEl,
    setBusy(b) {
      bodyEl.classList.toggle("is-busy", !!b);
    },
    setStatus(s) {
      statusEl.textContent = s || "";
    },
    close: dismissActive,
    _onKey: onKey,
    opts
  };
  ACTIVE = controller;
  if (opts.showSearch !== false) {
    requestAnimationFrame(() => {
      if (ACTIVE === controller)
        searchEl.focus();
    });
  }
  return controller;
}

// src/touch-manager-ui.ts
import { app } from "/scripts/app.js";

// src/manager-core.ts
function formatProgress(done, total) {
  return `checked ${done}/${total}`;
}
function partitionUpdateResults(results) {
  const actionable = [];
  const errored = [];
  const upToDate = [];
  for (const r of results) {
    if (r.error)
      errored.push(r);
    else if (r.update_available)
      actionable.push(r);
    else
      upToDate.push(r);
  }
  return { actionable, errored, upToDate };
}
function mergeVersionEntries(gitInfo, registryVersions) {
  const out = [];
  if (gitInfo) {
    for (const ref of versionOptions(gitInfo))
      out.push({ kind: "git", label: ref, ref });
  }
  for (const v of registryVersions) {
    out.push({
      kind: "registry",
      label: v.version,
      version: v.version,
      meta: v.deprecated ? "deprecated" : undefined
    });
  }
  return out;
}
function iconForKind(kind) {
  return kind === "git" ? "git" : "registry";
}
function formatDownloads(n) {
  const v = typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
  if (v >= 1e6)
    return `${(v / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  if (v >= 1000)
    return `${(v / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(v);
}
function formatRegistryMeta(node) {
  const parts = [];
  if (node.author)
    parts.push(node.author);
  parts.push(`${formatDownloads(node.downloads)} downloads`);
  if (node.latest_version)
    parts.push(`v${node.latest_version}`);
  return parts.join(" · ");
}
function installPermitted(config) {
  if (!config)
    return true;
  return config.is_loopback || config.allow_remote_install;
}
function rebootPermitted(config) {
  return config ? config.reboot_allowed : false;
}
var ALLOWED_INSTALL_HOSTS = new Set(["github.com", "gitlab.com"]);
function sanitizePackName(raw) {
  if (raw.includes("/") || raw.includes("\\"))
    return "";
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, "");
  if (cleaned === "" || cleaned === "." || cleaned === "..")
    return "";
  return cleaned;
}
function validateInstallUrl(rawUrl) {
  const url = (rawUrl ?? "").trim();
  if (!url)
    return { ok: false, code: "invalid_url", reason: "empty" };
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, code: "invalid_url", reason: "unparseable" };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, code: "invalid_url", reason: "not_https" };
  }
  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_INSTALL_HOSTS.has(host)) {
    return { ok: false, code: "invalid_url", reason: "host_not_allowed" };
  }
  const segments = parsed.pathname.split("/").filter((s) => s.length > 0);
  if (segments.length < 2) {
    return { ok: false, code: "invalid_url", reason: "missing_owner_repo" };
  }
  const owner = segments[0] ?? "";
  let last = segments[segments.length - 1] ?? "";
  if (last.endsWith(".git"))
    last = last.slice(0, -4);
  const name = sanitizePackName(last);
  if (!name)
    return { ok: false, code: "invalid_url", reason: "bad_name" };
  return { ok: true, name, host, owner };
}
function urlValidationHint(reason) {
  switch (reason) {
    case "empty":
      return "Enter a repository URL.";
    case "unparseable":
      return "Not a valid URL.";
    case "not_https":
      return "URL must start with https://";
    case "host_not_allowed":
      return "Only github.com and gitlab.com are allowed.";
    case "missing_owner_repo":
      return "URL must be https://github.com/<owner>/<repo>.";
    case "bad_name":
      return "Could not derive a safe directory name from the URL.";
  }
}
function shortSha(sha) {
  return sha ? sha.slice(0, 7) : "";
}
function formatRef(ref) {
  if (!ref)
    return "unknown";
  const sha = shortSha(ref.sha);
  if (ref.type === "detached")
    return sha ? `detached @ ${sha}` : "detached";
  if (ref.name)
    return sha ? `${ref.name} @ ${sha}` : ref.name;
  return sha || ref.type;
}
function formatUpdateStatus(info) {
  if (info.error)
    return `error: ${info.error}`;
  if (info.update_available) {
    const parts = [];
    if (info.behind > 0)
      parts.push(`${info.behind} behind`);
    if (info.ahead > 0)
      parts.push(`${info.ahead} ahead`);
    return parts.length ? `update available — ${parts.join(", ")}` : "update available";
  }
  if (info.ahead > 0)
    return `${info.ahead} ahead (local commits)`;
  return "up to date";
}
function formatUpdateSummary(r) {
  if (r.commits_applied === 0)
    return "Already up to date — nothing to apply.";
  const parts = [];
  if (r.before_short && r.after_short)
    parts.push(`${r.before_short} → ${r.after_short}`);
  const commits = `${r.commits_applied} commit${r.commits_applied === 1 ? "" : "s"}`;
  parts.push(r.truncated ? `${commits} (log truncated)` : commits);
  if (r.changed_files > 0) {
    parts.push(`${r.changed_files} file${r.changed_files === 1 ? "" : "s"} changed`);
  }
  return parts.join(" · ");
}
function formatDepsWarning(r) {
  return r.deps_changed ? "requirements.txt changed — install Python dependencies manually, then restart." : null;
}
function formatCommitLine(entry) {
  return `${entry.sha} ${entry.subject}`.trim();
}
function formatCoreBehind(behind) {
  const parts = [];
  if (behind.origin != null && behind.origin > 0)
    parts.push(`${behind.origin} behind origin`);
  if (behind.upstream != null && behind.upstream > 0)
    parts.push(`${behind.upstream} behind upstream`);
  return parts.length ? parts.join(", ") : "up to date";
}
var PREFERRED_BRANCHES = ["main", "master", "develop"];
function parseSemver(tag) {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(tag.trim());
  if (!m)
    return null;
  return [Number(m[1] ?? 0), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}
function compareTagsDesc(a, b) {
  const sa = parseSemver(a);
  const sb = parseSemver(b);
  if (sa && sb) {
    for (let i = 0;i < 3; i++) {
      const diff = (sb[i] ?? 0) - (sa[i] ?? 0);
      if (diff !== 0)
        return diff;
    }
    return a.localeCompare(b);
  }
  if (sa)
    return -1;
  if (sb)
    return 1;
  return a.localeCompare(b);
}
function sortBranches(branches) {
  return [...branches].sort((a, b) => {
    const ia = PREFERRED_BRANCHES.indexOf(a);
    const ib = PREFERRED_BRANCHES.indexOf(b);
    if (ia !== -1 || ib !== -1) {
      if (ia === -1)
        return 1;
      if (ib === -1)
        return -1;
      return ia - ib;
    }
    return a.localeCompare(b);
  });
}
function sortTags(tags) {
  return [...tags].sort(compareTagsDesc);
}
function versionOptions(info) {
  const seen = new Set;
  const out = [];
  for (const ref of [...sortBranches(info.branches), ...sortTags(info.tags)]) {
    if (seen.has(ref))
      continue;
    seen.add(ref);
    out.push(ref);
  }
  return out;
}
function filterPacks(query, packs) {
  const q = query.trim();
  if (!q) {
    return [...packs].sort((a, b) => a.name.localeCompare(b.name)).map((pack) => ({ pack, primaryMatches: [] }));
  }
  const scored = [];
  for (const pack of packs) {
    const r = fuzzyRank(q, [pack.name, pack.remote_url ?? null]);
    if (r)
      scored.push({ pack, score: r.score, primaryMatches: r.primaryMatches });
  }
  scored.sort((a, b) => b.score - a.score || a.pack.name.localeCompare(b.pack.name));
  return scored.map(({ pack, primaryMatches }) => ({ pack, primaryMatches }));
}

// src/touch-manager-ui.ts
var EXT_NAME = "comfyui-touch-manager";
var SETTING_ALLOW_REMOTE = "TouchManager.AllowRemoteInstall";

class ManagerError extends Error {
  code;
  constructor(message, code) {
    super(message);
    this.name = "ManagerError";
    this.code = code;
  }
}
async function apiGet(path) {
  const res = await app.api.fetchApi(app.api.apiURL(`/touch_manager/${path}`));
  const data = await res.json();
  if (!data.ok)
    throw new ManagerError(data.error ?? "request failed", data.code);
  return data;
}
async function apiPost(path, body) {
  const res = await app.api.fetchApi(app.api.apiURL(`/touch_manager/${path}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!data.ok)
    throw new ManagerError(data.error ?? "request failed", data.code);
  return data;
}
function hasExtMgr() {
  return typeof app !== "undefined" && !!app.extensionManager;
}
function toast(severity, summary, detail, life) {
  try {
    notify({ severity, summary, detail, ...life !== undefined ? { life } : {} });
  } catch (e) {
    console.warn(`[${EXT_NAME}] toast failed`, e);
  }
}
function confirmAction(state, title, message, opts = {}) {
  return new Promise((resolve) => {
    const overlay = el("div", "tm-confirm-overlay");
    const box = el("div", "tm-confirm-box");
    box.appendChild(el("div", "tm-confirm-title", title));
    box.appendChild(el("div", "tm-confirm-msg", message));
    const actions = el("div", "tm-confirm-actions");
    let settled = false;
    const finish = (result) => {
      if (settled)
        return;
      settled = true;
      window.removeEventListener("keydown", onKey, true);
      overlay.remove();
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        finish(false);
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopImmediatePropagation();
        finish(true);
      }
    };
    const cancel = button("Cancel", "tm-confirm-cancel", () => finish(false));
    const ok = button(opts.confirmLabel ?? "Confirm", `tm-confirm-ok ${opts.danger ? "tm-btn-danger" : "tm-btn-primary"}`, () => finish(true));
    actions.append(cancel, ok);
    box.appendChild(actions);
    overlay.appendChild(box);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay)
        finish(false);
    });
    state.shell.dialog.appendChild(overlay);
    window.addEventListener("keydown", onKey, true);
    requestAnimationFrame(() => ok.focus());
  });
}
var STYLE_ID3 = "touch-manager-style";
function ensureStyle3() {
  if (document.getElementById(STYLE_ID3))
    return;
  const s = document.createElement("style");
  s.id = STYLE_ID3;
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
.tm-updates-head { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.tm-updates-head .tm-row-meta { margin-left: auto; }
/* In-modal confirmation. The shell sits at z-index 9999; ComfyUI's own
   PrimeVue confirm dialog renders BELOW it (≈1100) and is invisible behind
   our backdrop — so we draw our own overlay inside the dialog instead. */
.tm-confirm-overlay { position: absolute; inset: 0; z-index: 5; display: flex;
  align-items: center; justify-content: center; padding: 16px;
  background: rgba(0,0,0,0.55); backdrop-filter: blur(2px); }
.tm-confirm-box { width: min(460px, 100%); display: flex; flex-direction: column; gap: 12px;
  padding: 18px; border-radius: 12px; background: var(--comfy-menu-bg, #1e1e1e);
  border: 1px solid var(--border-color, #444); box-shadow: 0 16px 48px rgba(0,0,0,0.7); }
.tm-confirm-title { font-size: 17px; font-weight: 700; }
.tm-confirm-msg { font-size: 14px; line-height: 1.45; opacity: 0.9; word-break: break-word; }
.tm-confirm-actions { display: flex; gap: 10px; justify-content: flex-end; flex-wrap: wrap; }
.cmp-match { text-decoration: underline; }
`;
  document.head.appendChild(s);
}
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className)
    node.className = className;
  if (text != null)
    node.textContent = text;
  return node;
}
function button(label, className, onClick) {
  const b = el("button", `tm-btn ${className}`, label);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}
function emptyState(message) {
  return el("div", "tm-empty", message);
}
function restartBanner(state) {
  const banner = el("div", "tm-restart");
  banner.appendChild(el("div", undefined, "Restart ComfyUI to apply changes."));
  if (rebootPermitted(state.config)) {
    const actions = el("div", "tm-row-actions");
    actions.appendChild(button("Restart now", "tm-btn-primary", () => void doReboot(state)));
    banner.appendChild(actions);
  }
  return banner;
}
function openManager() {
  try {
    ensureStyle3();
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
    height: "92vh"
  });
  const state = {
    shell,
    config: null,
    installed: [],
    activeTab: "installed",
    restartPending: false,
    updates: null,
    search: { installed: "", updates: "" },
    updatesScroll: 0
  };
  const tabBar = el("div", "tm-tabs");
  const tabs = [
    { id: "installed", label: "Installed" },
    { id: "updates", label: "Updates" },
    { id: "install", label: "Install URL" },
    { id: "registry", label: "Registry" },
    { id: "core", label: "Core" }
  ];
  const tabButtons = new Map;
  for (const t of tabs) {
    const b = el("button", "tm-tab", t.label);
    b.type = "button";
    b.addEventListener("click", () => selectTab(t.id));
    tabButtons.set(t.id, b);
    tabBar.appendChild(b);
  }
  shell.toolbarEl.appendChild(tabBar);
  function selectTab(id) {
    if (state.activeTab === "updates")
      state.updatesScroll = shell.bodyEl.scrollTop;
    state.activeTab = id;
    for (const [tid, b] of tabButtons)
      b.classList.toggle("tm-active", tid === id);
    syncSearch(state);
    shell.setStatus("");
    renderActiveTab(state, id);
  }
  shell.searchEl.addEventListener("input", () => {
    if (state.activeTab === "installed") {
      state.search.installed = shell.searchEl.value;
      renderInstalledList(state);
    } else if (state.activeTab === "updates") {
      state.search.updates = shell.searchEl.value;
      repaintUpdatesList(state);
    }
  });
  (async () => {
    try {
      state.config = await apiGet("config");
    } catch (e) {
      console.warn(`[${EXT_NAME}] config load failed`, e);
      state.config = null;
    }
    selectTab("installed");
  })();
}
async function renderActiveTab(state, id) {
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
function resetBody(state) {
  const body = state.shell.bodyEl;
  body.replaceChildren();
  if (state.restartPending)
    body.appendChild(restartBanner(state));
  const section = el("div", "tm-section");
  body.appendChild(section);
  return section;
}
function syncSearch(state) {
  const onInstalled = state.activeTab === "installed";
  const onUpdates = state.activeTab === "updates" && state.updates != null;
  const row = state.shell.searchEl.parentElement;
  if (row)
    row.style.display = onInstalled || onUpdates ? "" : "none";
  if (onInstalled) {
    state.shell.searchEl.placeholder = "Filter installed packs…";
    state.shell.searchEl.value = state.search.installed;
  } else if (onUpdates) {
    state.shell.searchEl.placeholder = "Filter updates…";
    state.shell.searchEl.value = state.search.updates;
  }
}
function markRestartPending(state) {
  state.restartPending = true;
}
async function renderInstalledTab(state) {
  const section = resetBody(state);
  section.appendChild(emptyState("Loading installed packs…"));
  state.shell.setBusy(true);
  try {
    const data = await apiGet("installed");
    state.installed = data.packs ?? [];
  } catch (e) {
    state.installed = [];
    section.replaceChildren(emptyState(`Failed to load: ${e.message}`));
    return;
  } finally {
    state.shell.setBusy(false);
  }
  renderInstalledList(state);
}
function renderInstalledList(state) {
  const section = resetBody(state);
  const query = state.shell.searchEl.value;
  const ranked = filterPacks(query, state.installed);
  state.shell.setStatus(`${ranked.length}/${state.installed.length}`);
  if (ranked.length === 0) {
    section.appendChild(emptyState(state.installed.length === 0 ? "No packs found." : "No matches."));
    return;
  }
  const list = el("div", "tm-list");
  for (const { pack, primaryMatches } of ranked) {
    list.appendChild(installedRow(state, pack, primaryMatches));
  }
  section.appendChild(list);
}
function installedRow(state, pack, matches) {
  const row = el("div", "tm-row");
  const title = el("div", "tm-row-title");
  title.appendChild(highlightMatches(pack.name, matches));
  if (!pack.enabled) {
    const tag = el("span", "tm-row-meta", "  (disabled)");
    title.appendChild(tag);
  }
  row.appendChild(title);
  const metaBits = [];
  if (pack.is_git)
    metaBits.push(formatRef(pack.ref));
  else
    metaBits.push("not a git repo");
  if (pack.dirty)
    metaBits.push("local changes");
  row.appendChild(el("div", "tm-row-meta", metaBits.join(" · ")));
  if (pack.remote_url)
    row.appendChild(el("div", "tm-row-meta", pack.remote_url));
  const actions = el("div", "tm-row-actions");
  const gitDisabledReason = pack.is_git ? "" : "not a git repo";
  const updateBtn = button("Update", "", () => void doUpdate(state, pack.name));
  updateBtn.disabled = !pack.is_git;
  if (gitDisabledReason)
    updateBtn.title = gitDisabledReason;
  actions.appendChild(updateBtn);
  const versionsBtn = button("Versions", "", () => void openVersions(state, pack));
  versionsBtn.disabled = !pack.is_git;
  if (gitDisabledReason)
    versionsBtn.title = gitDisabledReason;
  actions.appendChild(versionsBtn);
  if (pack.enabled) {
    actions.appendChild(button("Uninstall", "tm-btn-danger", () => void doUninstall(state, pack.name)));
  }
  row.appendChild(actions);
  return row;
}
function removeFromUpdatesCache(state, name) {
  if (!state.updates)
    return;
  state.updates.results = state.updates.results.filter((r) => r.name !== name);
}
function updateResultBack(state, origin) {
  if (origin === "updates") {
    return button("← Back to updates", "", () => void renderUpdatesTab(state));
  }
  return button("← Back to installed", "", () => void renderInstalledTab(state));
}
async function doUpdate(state, name, opts = {}) {
  if (opts.origin === "updates")
    state.updatesScroll = state.shell.bodyEl.scrollTop;
  state.shell.setBusy(true);
  try {
    const result = await apiPost("update", opts.ref ? { name, ref: opts.ref } : { name });
    markRestartPending(state);
    removeFromUpdatesCache(state, name);
    toast("success", `Updated ${name}`, formatUpdateSummary(result));
    state.shell.setBusy(false);
    renderUpdateResult(state, { ...result, name }, updateResultBack(state, opts.origin));
  } catch (e) {
    const err = e;
    toast("error", `Update failed: ${name}`, `${err.message}${err.code ? ` (${err.code})` : ""}`);
    state.shell.setBusy(false);
  }
}
function renderUpdateResult(state, result, back) {
  const section = resetBody(state);
  section.appendChild(back);
  section.appendChild(el("div", "tm-row-title", `Updated ${result.name}`));
  section.appendChild(el("div", "tm-row-meta", formatUpdateSummary(result)));
  const depsWarning = formatDepsWarning(result);
  if (depsWarning)
    section.appendChild(el("div", "tm-note tm-note-warn", depsWarning));
  if (result.commit_log.length > 0) {
    section.appendChild(el("div", "tm-field-label", "Applied commits"));
    const list = el("div", "tm-list");
    for (const entry of result.commit_log) {
      list.appendChild(el("div", "tm-row-meta", formatCommitLine(entry)));
    }
    if (result.truncated)
      list.appendChild(el("div", "tm-row-meta", "…older commits omitted"));
    section.appendChild(list);
  }
}
async function doUninstall(state, name) {
  const ok = await confirmAction(state, "Disable pack?", `Disable "${name}"? The directory is renamed to "${name}.disabled" (reversible), not deleted. A restart is required.`, { confirmLabel: "Disable", danger: true });
  if (!ok)
    return;
  state.shell.setBusy(true);
  try {
    await apiPost("uninstall", { name });
    markRestartPending(state);
    state.updates = null;
    toast("success", `Disabled ${name}`, "Restart ComfyUI to apply.");
    await renderInstalledTab(state);
  } catch (e) {
    const err = e;
    toast("error", `Uninstall failed: ${name}`, `${err.message}${err.code ? ` (${err.code})` : ""}`);
  } finally {
    state.shell.setBusy(false);
  }
}
async function openVersions(state, pack) {
  const section = resetBody(state);
  const back = button("← Back to installed", "", () => void renderInstalledTab(state));
  section.appendChild(back);
  section.appendChild(el("div", "tm-row-title", `Versions — ${pack.name}`));
  section.appendChild(emptyState("Loading versions…"));
  state.shell.setBusy(true);
  let info;
  try {
    info = await apiGet(`versions?name=${encodeURIComponent(pack.name)}`);
  } catch (e) {
    section.replaceChildren(back, el("div", "tm-row-title", `Versions — ${pack.name}`), emptyState(`Failed: ${e.message}`));
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
      actions.appendChild(button("Checkout", "tm-btn-primary", () => void doUpdate(state, pack.name, { ref })));
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
      const meta = [rel.tag];
      if (rel.prerelease)
        meta.push("prerelease");
      if (rel.published_at)
        meta.push(rel.published_at);
      r.appendChild(el("div", "tm-row-meta", meta.join(" · ")));
      const actions = el("div", "tm-row-actions");
      actions.appendChild(button("Checkout", "tm-btn-primary", () => void doUpdate(state, pack.name, { ref: rel.tag })));
      r.appendChild(actions);
      list.appendChild(r);
    }
    section.appendChild(list);
  }
}
function lastCheckedLabel(cache) {
  const t = new Date(cache.checkedAt);
  const hh = String(t.getHours()).padStart(2, "0");
  const mm = String(t.getMinutes()).padStart(2, "0");
  return `Last checked ${hh}:${mm}`;
}
async function renderUpdatesTab(state) {
  if (!state.updates) {
    const section = resetBody(state);
    section.appendChild(button("Check for updates", "tm-btn-primary", () => void checkUpdates(state)));
    section.appendChild(el("div", "tm-note tm-note-info", "Fetches each git pack's remote and compares against the tracked branch. " + "Results are cached — update a pack and come back without re-checking everything."));
    return;
  }
  paintUpdatesTab(state);
  restoreUpdatesScroll(state);
}
function restoreUpdatesScroll(state) {
  const top = state.updatesScroll;
  if (top <= 0)
    return;
  requestAnimationFrame(() => {
    state.shell.bodyEl.scrollTop = top;
  });
}
function updateRow(state, info, matches = []) {
  const r = el("div", "tm-row");
  const title = el("div", "tm-row-title");
  title.appendChild(highlightMatches(info.name, matches));
  r.appendChild(title);
  r.appendChild(el("div", "tm-row-meta", formatUpdateStatus(info)));
  for (const c of info.incoming) {
    r.appendChild(el("div", "tm-row-meta", `${c.sha} ${c.subject}`));
  }
  const actions = el("div", "tm-row-actions");
  actions.appendChild(button("Update", "tm-btn-primary", () => void doUpdate(state, info.name, { origin: "updates" })));
  r.appendChild(actions);
  return r;
}
function paintUpdatesTab(state) {
  if (!state.updates)
    return;
  const section = resetBody(state);
  section.appendChild(el("div", "tm-updates-head"));
  section.appendChild(el("div", "tm-list tm-updates-list"));
  section.appendChild(el("div", "tm-section tm-updates-errors"));
  syncSearch(state);
  repaintUpdatesList(state);
}
function repaintUpdatesList(state) {
  const cache = state.updates;
  if (!cache)
    return;
  const body = state.shell.bodyEl;
  const head = body.querySelector(".tm-updates-head");
  const list = body.querySelector(".tm-updates-list");
  const errorsWrap = body.querySelector(".tm-updates-errors");
  if (!head || !list)
    return;
  head.replaceChildren();
  const recheck = button("Re-check", "tm-btn-primary", () => void checkUpdates(state));
  recheck.disabled = !cache.complete;
  head.appendChild(recheck);
  head.appendChild(el("div", "tm-row-meta", cache.complete ? lastCheckedLabel(cache) : "checking…"));
  const { actionable, errored } = partitionUpdateResults(cache.results);
  const ranked = filterPacks(state.search.updates, actionable);
  list.replaceChildren();
  for (const { pack, primaryMatches } of ranked) {
    list.appendChild(updateRow(state, pack, primaryMatches));
  }
  if (ranked.length === 0) {
    const message = actionable.length > 0 ? "No matches." : cache.complete ? "Everything is up to date." : "Checking…";
    list.appendChild(emptyState(message));
  }
  if (errorsWrap) {
    errorsWrap.replaceChildren();
    if (errored.length > 0) {
      errorsWrap.appendChild(el("div", "tm-field-label", "Could not check"));
      for (const e of errored) {
        errorsWrap.appendChild(el("div", "tm-row-meta", `${e.name}: ${e.error}`));
      }
    }
  }
  state.shell.setStatus(cache.complete ? `${ranked.length}/${actionable.length}` : formatProgress(cache.results.length, cache.total));
}
var UPDATE_CHECK_CONCURRENCY = 3;
async function checkUpdates(state) {
  const cache = { results: [], total: 0, checkedAt: Date.now(), complete: false };
  state.updates = cache;
  state.updatesScroll = 0;
  const section = resetBody(state);
  section.appendChild(emptyState("Listing git-backed packs…"));
  state.shell.setBusy(true);
  let names;
  try {
    const data = await apiGet("updates/list");
    names = (data.packs ?? []).map((p) => p.name);
  } catch (e) {
    state.shell.setBusy(false);
    if (state.updates !== cache)
      return;
    state.updates = null;
    const s = resetBody(state);
    s.appendChild(button("Check for updates", "tm-btn-primary", () => void checkUpdates(state)));
    s.appendChild(emptyState(`Failed: ${e.message}`));
    return;
  }
  state.shell.setBusy(false);
  if (state.updates !== cache)
    return;
  cache.total = names.length;
  if (names.length === 0) {
    cache.complete = true;
    paintUpdatesTab(state);
    return;
  }
  paintUpdatesTab(state);
  let cursor = 0;
  const worker = async () => {
    while (cursor < names.length) {
      const name = names[cursor++];
      if (name === undefined)
        break;
      let info;
      try {
        info = await apiGet(`updates/check?name=${encodeURIComponent(name)}`);
      } catch (e) {
        info = {
          name,
          update_available: false,
          behind: 0,
          ahead: 0,
          error: e.message,
          incoming: []
        };
      }
      if (state.updates !== cache)
        return;
      cache.results.push(info);
      if (state.activeTab === "updates")
        repaintUpdatesList(state);
    }
  };
  await Promise.all(Array.from({ length: Math.min(UPDATE_CHECK_CONCURRENCY, names.length) }, () => worker()));
  if (state.updates !== cache)
    return;
  cache.complete = true;
  if (state.activeTab === "updates")
    repaintUpdatesList(state);
}
async function renderInstallTab(state) {
  const section = resetBody(state);
  const cfg = state.config;
  const settingAllow = readAllowRemoteSetting();
  const blocked = !installPermitted(cfg);
  if (cfg && !cfg.is_loopback) {
    section.appendChild(el("div", "tm-note tm-note-warn", blocked ? "ComfyUI is bound to a non-loopback address. Install from URL is disabled on the server (set TOUCH_MANAGER_ALLOW_REMOTE_INSTALL=1 to allow)." : "ComfyUI is bound to a non-loopback address but remote install is explicitly allowed. Only install repositories you trust."));
  } else {
    section.appendChild(el("div", "tm-note tm-note-info", "Clones a github.com or gitlab.com repository into custom_nodes. A restart is required to load it. Only install code you trust."));
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
  const installBtn = button("Install", "tm-btn-primary", () => void doInstall(state, input.value, refInput.value));
  section.appendChild(installBtn);
  const refresh = () => {
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
    section.appendChild(el("div", "tm-row-meta", "Your local setting allows remote install, but the server has not enabled it."));
  }
  refresh();
}
function readAllowRemoteSetting() {
  try {
    if (hasExtMgr()) {
      return app.extensionManager.setting.get(SETTING_ALLOW_REMOTE) === true;
    }
  } catch (e) {
    console.warn(`[${EXT_NAME}] setting read failed`, e);
  }
  return false;
}
async function doInstall(state, url, ref) {
  const v = validateInstallUrl(url);
  if (!v.ok) {
    toast("warn", "Invalid URL", urlValidationHint(v.reason));
    return;
  }
  const ok = await confirmAction(state, "Install pack?", `Clone ${url.trim()} into custom_nodes as "${v.name}"? Only install code you trust. A restart is required.`, { confirmLabel: "Install" });
  if (!ok)
    return;
  state.shell.setBusy(true);
  try {
    const body = { url: url.trim() };
    if (ref.trim())
      body.ref = ref.trim();
    const res = await apiPost("install", body);
    markRestartPending(state);
    state.updates = null;
    toast("success", `Installed ${res.name}`, "Restart ComfyUI to apply.");
    await renderInstalledTab(state);
  } catch (e) {
    const err = e;
    toast("error", "Install failed", `${err.message}${err.code ? ` (${err.code})` : ""}`);
  } finally {
    state.shell.setBusy(false);
  }
}
async function renderRegistryTab(state) {
  const section = resetBody(state);
  section.appendChild(el("div", "tm-note tm-note-info", "Search the Comfy Registry and install a node. Python dependencies are " + "NOT installed automatically — install them and restart afterwards."));
  section.appendChild(el("div", "tm-field-label", "Search the registry"));
  const input = el("input", "tm-input");
  input.type = "search";
  input.placeholder = "e.g. controlnet, upscale, ipadapter…";
  input.autocomplete = "off";
  input.spellcheck = false;
  section.appendChild(input);
  const results = el("div", "tm-section");
  section.appendChild(results);
  const run = (page) => void searchRegistry(state, input.value, page, results);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter")
      run(1);
  });
  section.appendChild(button("Search", "tm-btn-primary", () => run(1)));
}
async function searchRegistry(state, query, page, results) {
  results.replaceChildren(emptyState("Searching the registry…"));
  state.shell.setBusy(true);
  let data;
  try {
    data = await apiGet(`registry/search?q=${encodeURIComponent(query)}&page=${page}`);
  } catch (e) {
    results.replaceChildren(emptyState(`Registry search failed: ${e.message}`));
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
  for (const node of nodes)
    list.appendChild(registryRow(state, node));
  results.appendChild(list);
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
function registryRow(state, node) {
  const row = el("div", "tm-row");
  row.appendChild(el("div", "tm-row-title", node.name));
  row.appendChild(el("div", "tm-row-meta", formatRegistryMeta(node)));
  if (node.description)
    row.appendChild(el("div", "tm-row-meta", node.description));
  const actions = el("div", "tm-row-actions");
  actions.appendChild(button("Versions", "tm-btn-primary", () => void openRegistryVersions(state, node)));
  row.appendChild(actions);
  return row;
}
async function openRegistryVersions(state, node) {
  const section = resetBody(state);
  const back = button("← Back to registry", "", () => void renderRegistryTab(state));
  section.appendChild(back);
  section.appendChild(el("div", "tm-row-title", `Versions — ${node.name}`));
  section.appendChild(emptyState("Loading versions…"));
  state.shell.setBusy(true);
  let versions;
  try {
    const data = await apiGet(`registry/versions?id=${encodeURIComponent(node.id)}`);
    versions = data.versions ?? [];
  } catch (e) {
    section.replaceChildren(back, el("div", "tm-row-title", `Versions — ${node.name}`), emptyState(`Failed: ${e.message}`));
    state.shell.setBusy(false);
    return;
  }
  state.shell.setBusy(false);
  section.replaceChildren();
  section.appendChild(back);
  section.appendChild(el("div", "tm-row-title", `Versions — ${node.name}`));
  const entries = mergeVersionEntries(null, versions);
  const repoOk = node.repository ? validateInstallUrl(node.repository).ok : false;
  if (repoOk) {
    entries.unshift({ kind: "git", label: `${node.repository} (default branch)` });
  }
  if (entries.length === 0) {
    section.appendChild(emptyState("No installable versions found."));
    return;
  }
  const list = el("div", "tm-list");
  for (const entry of entries)
    list.appendChild(registryVersionRow(state, node, entry));
  section.appendChild(list);
}
function registryVersionRow(state, node, entry) {
  const r = el("div", "tm-row");
  const head = el("div", "tm-row-head");
  const badge = el("span", `tm-badge tm-badge-${entry.kind}`, iconForKind(entry.kind));
  head.appendChild(badge);
  head.appendChild(el("span", "tm-row-title", entry.label));
  r.appendChild(head);
  if (entry.meta)
    r.appendChild(el("div", "tm-row-meta", entry.meta));
  const actions = el("div", "tm-row-actions");
  if (entry.kind === "git") {
    actions.appendChild(button("Install (git)", "tm-btn-primary", () => void doInstall(state, node.repository, "")));
  } else {
    actions.appendChild(button("Install", "tm-btn-primary", () => void doRegistryInstall(state, node, entry.version ?? null)));
  }
  r.appendChild(actions);
  return r;
}
async function doRegistryInstall(state, node, version) {
  const label = version ? `${node.name}@${version}` : `${node.name} (latest)`;
  const ok = await confirmAction(state, "Install from registry?", `Download and install ${label} from the Comfy Registry into custom_nodes? ` + "Only install code you trust. A restart is required.", { confirmLabel: "Install" });
  if (!ok)
    return;
  state.shell.setBusy(true);
  try {
    const body = { id: node.id, name: node.id };
    if (version)
      body.version = version;
    const res = await apiPost("registry/install", body);
    markRestartPending(state);
    state.updates = null;
    const detail = res.deps_changed ? "Python dependencies changed — install them, then restart." : "Restart ComfyUI to apply.";
    toast("success", `Installed ${res.name}${res.version ? `@${res.version}` : ""}`, detail);
    state.shell.setBusy(false);
    await renderInstalledTab(state);
  } catch (e) {
    const err = e;
    toast("error", "Registry install failed", `${err.message}${err.code ? ` (${err.code})` : ""}`);
    state.shell.setBusy(false);
  }
}
async function renderCoreTab(state) {
  const section = resetBody(state);
  section.appendChild(emptyState("Loading core repo info…"));
  state.shell.setBusy(true);
  let info;
  try {
    info = await apiGet("core");
  } catch (e) {
    section.replaceChildren(emptyState(`Failed: ${e.message}`));
    state.shell.setBusy(false);
    return;
  }
  state.shell.setBusy(false);
  section.replaceChildren();
  section.appendChild(el("div", "tm-row-title", "ComfyUI core"));
  if (!info.is_git) {
    section.appendChild(el("div", "tm-note tm-note-warn", "Core is not a git checkout — it cannot be updated from here."));
    return;
  }
  const row = el("div", "tm-row");
  row.appendChild(el("div", "tm-row-meta", `Ref: ${formatRef(info.ref)}`));
  row.appendChild(el("div", "tm-row-meta", formatCoreBehind(info.behind)));
  if (info.dirty)
    row.appendChild(el("div", "tm-row-meta", "Working tree has local changes."));
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
  section.appendChild(el("div", "tm-note tm-note-info", "Runs git pull on the core repo. Does not install Python dependencies or restart — do those yourself after."));
}
async function doReboot(state) {
  const ok = await confirmAction(state, "Restart ComfyUI?", "Restart the ComfyUI server now to apply changes? The server will be briefly unavailable while it comes back up.", { confirmLabel: "Restart now", danger: true });
  if (!ok)
    return;
  toast("info", "Restarting ComfyUI…", "The server will be briefly unavailable.", 8000);
  const section = resetBody(state);
  section.appendChild(el("div", "tm-row-title", "Restarting ComfyUI…"));
  section.appendChild(el("div", "tm-note tm-note-info", "The server is restarting. This page will reconnect once it is back; reload if it does not."));
  try {
    await apiPost("reboot", {});
  } catch (e) {
    if (e instanceof ManagerError) {
      toast("error", "Restart failed", `${e.message}${e.code ? ` (${e.code})` : ""}`);
      await renderCoreTab(state);
    }
  }
}
async function doCoreUpdate(state) {
  const ok = await confirmAction(state, "Update ComfyUI core?", "Run git pull on the core repo? Python dependencies are NOT installed automatically and a manual restart is required.", { confirmLabel: "Update core" });
  if (!ok)
    return;
  state.shell.setBusy(true);
  try {
    const res = await apiPost("core/update", {});
    markRestartPending(state);
    const detail = res.deps_changed ? "requirements.txt changed — reinstall deps, then restart." : "Restart ComfyUI to apply.";
    toast("success", "Core updated", detail);
    await renderCoreTab(state);
  } catch (e) {
    const err = e;
    toast("error", "Core update failed", `${err.message}${err.code ? ` (${err.code})` : ""}`);
  } finally {
    state.shell.setBusy(false);
  }
}

// src/index.ts
var EXT_NAME2 = "comfyui-touch-manager";
var OPEN_COMMAND_ID = "TouchManager.Open";
function safeOpen() {
  try {
    openManager();
  } catch (e) {
    console.error(`[${EXT_NAME2}] failed to open node manager`, e);
  }
}
app2.registerExtension({
  name: "comfy.touch-manager",
  settings: [
    {
      id: "TouchManager.AllowRemoteInstall",
      name: "Touch Manager: allow install from URL on non-loopback binds",
      tooltip: "Informational only — the server's TOUCH_MANAGER_ALLOW_REMOTE_INSTALL env + bind address are the real gate.",
      type: "boolean",
      defaultValue: false
    }
  ],
  commands: [
    {
      id: OPEN_COMMAND_ID,
      label: "Touch Node Manager",
      icon: "pi pi-th-large",
      function: () => safeOpen()
    }
  ],
  menuCommands: [
    {
      path: ["Extensions"],
      commands: [OPEN_COMMAND_ID]
    }
  ],
  actionBarButtons: [
    {
      icon: "pi pi-th-large",
      tooltip: "Touch Node Manager",
      onClick: () => safeOpen()
    }
  ],
  setup() {
    try {
      const em = app2.extensionManager;
      em?.registerSidebarTab?.({
        id: "touch-manager",
        type: "custom",
        title: "Node Manager",
        icon: "pi pi-th-large",
        tooltip: "Touch Node Manager",
        render: (container) => {
          container.replaceChildren();
          const btn = document.createElement("button");
          btn.type = "button";
          btn.textContent = "Open Node Manager";
          btn.style.cssText = "margin:12px;min-height:44px;padding:10px 14px;font-size:15px;border-radius:8px;cursor:pointer;";
          btn.addEventListener("click", safeOpen);
          container.appendChild(btn);
        }
      });
    } catch (e) {
      console.warn(`[${EXT_NAME2}] sidebar tab registration failed`, e);
    }
  }
});
export {
  versionOptions,
  validateInstallUrl,
  sanitizePackName,
  formatUpdateStatus,
  formatRef,
  filterPacks
};
