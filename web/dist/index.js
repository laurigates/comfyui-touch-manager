/*!
 * comfyui-touch-manager - web/dist/index.js (generated frontend bundle)
 * Built by bun from this repo TypeScript src/ - not hand-written. It inlines
 * ONE first-party dependency, marked below by its bun module-path comment:
 * // node_modules/@laurigates/comfy-modal-kit/dist/index.js
 *
 *   PackageURL:  pkg:npm/@laurigates/comfy-modal-kit@0.6.0
 *   SPDX-License-Identifier: MIT
 *   Source repo: https://github.com/laurigates/comfy-modal-kit
 *   npm:         https://www.npmjs.com/package/@laurigates/comfy-modal-kit
 *
 * Upstream origin, for registry vendored-code scanners: this is NOT
 * unattributed third-party vendored code. The bundled package is FIRST-PARTY,
 * published to npm with build provenance (SLSA, signed via GitHub Actions)
 * attesting it was built from the source repo above. The npm scope @laurigates,
 * the GitHub org laurigates, and this pack Comfy Registry PublisherId laurigates
 * (see pyproject.toml [tool.comfy]) are one and the same author/identity.
 * Verify: npm view @laurigates/comfy-modal-kit dist.attestations
 */

// node_modules/@laurigates/comfy-modal-kit/dist/index.js
var KEY = Symbol.for("laurigates.comfyModalKit");
function getKit() {
  const g = globalThis;
  let kit = g[KEY];
  if (!kit) {
    kit = { fieldProviders: [], activeModal: null, pointerClaim: null };
    g[KEY] = kit;
  }
  return kit;
}
function ensureStyleOnce(id, css) {
  if (typeof document === "undefined")
    return;
  if (document.getElementById(id))
    return;
  const s = document.createElement("style");
  s.id = id;
  s.textContent = css;
  document.head.appendChild(s);
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
  ensureStyleOnce(STYLE_ID, CSS);
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
var FAMILY_MENU_PATH = ["Extensions", "Touch Tools"];
var KEBAB_COMMAND_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+(?:-[a-z0-9]+)*$/;
function makeLauncher(opts) {
  if (!KEBAB_COMMAND_ID.test(opts.id)) {
    console.warn(`[comfy-modal-kit] launcher id "${opts.id}" does not match the family convention "<pack-short-name>.<action>" (kebab-case)`);
  }
  const safeOpen = () => {
    try {
      opts.open();
    } catch (e) {
      console.error(`[comfy-modal-kit] launcher "${opts.id}" open failed`, e);
      try {
        notify({
          severity: "error",
          summary: opts.failSummary ?? `Could not open ${opts.label}`,
          detail: String(e)
        });
      } catch (notifyErr) {
        console.warn(`[comfy-modal-kit] notify failed`, notifyErr);
      }
    }
  };
  const fields = {
    commands: [{ id: opts.id, label: opts.label, icon: opts.icon, function: safeOpen }],
    menuCommands: [{ path: [...opts.menuPath ?? FAMILY_MENU_PATH], commands: [opts.id] }]
  };
  if (opts.actionBar !== false) {
    const bar = typeof opts.actionBar === "object" ? opts.actionBar : {};
    fields.actionBarButtons = [
      {
        icon: opts.icon,
        ...bar.label !== undefined ? { label: bar.label } : {},
        tooltip: bar.tooltip ?? opts.tooltip ?? opts.label,
        onClick: safeOpen
      }
    ];
  }
  return fields;
}
var guardInstalled = false;
function setActiveModal(handle) {
  installPointerGuard();
  dismissActiveModal();
  getKit().activeModal = handle;
}
function dismissActiveModal() {
  const kit = getKit();
  const active = kit.activeModal;
  if (!active)
    return;
  kit.activeModal = null;
  try {
    active.close();
  } catch (e) {
    console.warn("[comfy-modal-kit] active modal close() threw", e);
  }
}
function getActiveModal() {
  return getKit().activeModal;
}
function installPointerGuard() {
  if (guardInstalled)
    return;
  if (typeof window === "undefined")
    return;
  guardInstalled = true;
  window.addEventListener("pointerdown", pointerGuard, true);
}
function pointerGuard(e) {
  const active = getKit().activeModal;
  if (!active)
    return;
  const target = e.target;
  if (active.element && target && active.element.contains(target)) {
    return;
  }
  e.stopImmediatePropagation();
  dismissActiveModal();
}
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
var STYLE_ID2 = "cmp-shell-style";
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
function openModalShell(opts = {}) {
  ensureStyleOnce(STYLE_ID2, CSS2);
  const backdrop = document.createElement("div");
  backdrop.className = "cmp-backdrop";
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
  let torn = false;
  const teardown = () => {
    if (torn)
      return;
    torn = true;
    try {
      backdrop.remove();
      dialog.remove();
      document.removeEventListener("keydown", onKey, true);
    } finally {
      try {
        opts.onClose?.();
      } catch (e) {
        console.warn("[modal-shell] onClose threw", e);
      }
    }
  };
  const handle = { id: "modal-shell", element: dialog, close: teardown };
  const requestClose = () => {
    if (getActiveModal() === handle) {
      dismissActiveModal();
    } else {
      teardown();
    }
  };
  backdrop.addEventListener("pointerdown", requestClose);
  closeBtn.addEventListener("click", requestClose);
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      requestClose();
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
    close: requestClose,
    _onKey: onKey,
    opts
  };
  setActiveModal(handle);
  if (opts.showSearch !== false) {
    requestAnimationFrame(() => {
      if (getActiveModal() === handle)
        searchEl.focus();
    });
  }
  return controller;
}
var STYLE_ID3 = "cmp-overlay-style";
var CSS3 = `
.cmp-ov-backdrop {
    position: absolute;
    inset: 0;
    z-index: 5;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    touch-action: manipulation;
}
.cmp-ov-card {
    background: #1c1c24;
    border: 1px solid #33333f;
    border-radius: 10px;
    padding: 18px;
    width: min(520px, calc(100% - 24px));
    max-height: calc(100% - 24px);
    display: flex;
    flex-direction: column;
    gap: 12px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
}
.cmp-ov-title { font-size: 15px; font-weight: 600; color: #e8e8ec; }
.cmp-ov-msg { font-size: 13px; color: #b8b8c0; line-height: 1.5; word-break: break-word; }
.cmp-ov-input {
    font-size: 16px;
    padding: 10px 12px;
    background: #12121a;
    border: 1px solid #3a3a44;
    border-radius: 6px;
    color: #e8e8ec;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
.cmp-ov-input:focus { outline: none; border-color: #6ba6ff; }
.cmp-ov-err { font-size: 12px; color: #ff7a7a; min-height: 14px; }
.cmp-ov-actions { display: flex; justify-content: flex-end; gap: 8px; }
.cmp-ov-btn {
    font-size: 13px;
    padding: 9px 16px;
    border-radius: 6px;
    border: 1px solid #3a3a44;
    background: #2a2a36;
    color: #d8d8dc;
    cursor: pointer;
    font-family: inherit;
    min-height: 38px;
}
.cmp-ov-btn:hover { background: #3a3a4a; color: #fff; }
.cmp-ov-primary { background: #2f3a52; color: #9ec6ff; border-color: #4a5878; }
.cmp-ov-primary:hover { background: #3a4868; color: #fff; }
.cmp-ov-danger { background: #4a2230; color: #ff9eb0; border-color: #78384a; }
.cmp-ov-danger:hover { background: #5c2a3c; color: #fff; }
`;
function openShellOverlay(shell, opts = {}) {
  ensureStyleOnce(STYLE_ID3, CSS3);
  const backdrop = document.createElement("div");
  backdrop.className = "cmp-ov-backdrop";
  const card = document.createElement("div");
  card.className = "cmp-ov-card";
  backdrop.appendChild(card);
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      dismiss();
    }
  };
  let closed = false;
  function close() {
    if (closed)
      return;
    closed = true;
    document.removeEventListener("keydown", onKey, true);
    document.addEventListener("keydown", shell._onKey, true);
    backdrop.remove();
  }
  function dismiss() {
    opts.onDismiss?.();
    close();
  }
  backdrop.addEventListener("pointerdown", (e) => {
    if (e.target === backdrop)
      dismiss();
  });
  document.removeEventListener("keydown", shell._onKey, true);
  document.addEventListener("keydown", onKey, true);
  shell.dialog.appendChild(backdrop);
  return { card, close };
}
function confirmInShell(shell, opts) {
  return new Promise((resolve) => {
    const ov = openShellOverlay(shell, { onDismiss: () => resolve(false) });
    const h = document.createElement("div");
    h.className = "cmp-ov-title";
    h.textContent = opts.title;
    const p = document.createElement("div");
    p.className = "cmp-ov-msg";
    p.textContent = opts.message;
    const row = document.createElement("div");
    row.className = "cmp-ov-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "cmp-ov-btn";
    cancel.textContent = opts.cancelLabel || "Cancel";
    cancel.addEventListener("click", () => {
      ov.close();
      resolve(false);
    });
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = opts.danger ? "cmp-ov-btn cmp-ov-danger" : "cmp-ov-btn cmp-ov-primary";
    ok.textContent = opts.confirmLabel || "OK";
    const confirm = () => {
      ov.close();
      resolve(true);
    };
    ok.addEventListener("click", confirm);
    if (opts.enterConfirms) {
      ov.card.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          confirm();
        }
      });
    }
    row.append(cancel, ok);
    ov.card.append(h, p, row);
    ok.focus();
  });
}

// src/index.ts
import { app as app2 } from "/scripts/app.js";

// src/touch-manager-ui.ts
import { app } from "/scripts/app.js";

// src/manager-core.ts
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
function deletePermitted(config) {
  return config ? config.delete_allowed : false;
}
function normalizeRepoUrl(raw) {
  const trimmed = (raw ?? "").trim().toLowerCase();
  if (!trimmed)
    return "";
  const ssh = /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+)$/.exec(trimmed);
  const candidate = ssh ? `https://${ssh[1]}/${ssh[2]}` : trimmed;
  const strip = (s) => s.replace(/\.git$/, "").replace(/\/+$/, "");
  try {
    const u = new URL(candidate);
    return `${u.hostname}${strip(u.pathname)}`;
  } catch {
    return strip(candidate);
  }
}
function sameRepo(a, b) {
  const na = normalizeRepoUrl(a);
  return na !== "" && na === normalizeRepoUrl(b);
}
function repoLabel(url) {
  const norm = normalizeRepoUrl(url);
  if (!norm)
    return "";
  const segments = norm.split("/");
  return segments.length >= 3 ? segments.slice(1).join("/") : norm;
}
function buildForkEntries(data) {
  const upstream = [data.source, data.parent].filter((r) => !!r);
  const forks = [...data.forks].sort((a, b) => b.stars - a.stars || a.full_name.localeCompare(b.full_name));
  const seen = new Set;
  const out = [];
  for (const [repo, role] of [
    ...upstream.map((r) => [r, "upstream"]),
    ...forks.map((r) => [r, "fork"])
  ]) {
    const key = normalizeRepoUrl(repo.url);
    if (seen.has(key))
      continue;
    seen.add(key);
    out.push({ repo, role: sameRepo(repo.url, data.current) ? "current" : role });
  }
  return out;
}
function formatForkMeta(repo) {
  const parts = [repo.owner, `★ ${formatDownloads(repo.stars)}`];
  if (repo.pushed_at)
    parts.push(`pushed ${repo.pushed_at.slice(0, 10)}`);
  if (repo.archived)
    parts.push("archived");
  return parts.join(" · ");
}
function formatRemoteSwitchSummary(r) {
  const parts = [];
  const before = repoLabel(r.remote_before);
  const after = repoLabel(r.remote_after);
  parts.push(before && before !== after ? `${before} → ${after}` : after);
  if (r.ref)
    parts.push(r.ref);
  if (r.before_short && r.after_short && r.before_short !== r.after_short) {
    parts.push(`${r.before_short} → ${r.after_short}`);
  }
  if (r.changed_files > 0) {
    parts.push(`${r.changed_files} file${r.changed_files === 1 ? "" : "s"} changed`);
  }
  return parts.join(" · ");
}
var RECONNECT_POLL = {
  graceMs: 1500,
  intervalMs: 2000,
  timeoutMs: 120000,
  countdownSeconds: 3
};
function reconnectExpired(elapsedMs, timeoutMs = RECONNECT_POLL.timeoutMs) {
  return elapsedMs >= timeoutMs;
}
function formatReconnectStatus(elapsedMs, timeoutMs = RECONNECT_POLL.timeoutMs) {
  if (reconnectExpired(elapsedMs, timeoutMs)) {
    return "ComfyUI is taking longer than expected to come back — reload when it is ready.";
  }
  const secs = Math.max(0, Math.floor(elapsedMs / 1000));
  return `Waiting for ComfyUI to come back… (${secs}s)`;
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
    if (info.source === "registry") {
      return info.latest_version ? `update available — v${info.latest_version}` : "update available";
    }
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
  if (r.source === "registry") {
    return r.before_version && r.after_version ? `${r.before_version} → ${r.after_version}` : "Updated.";
  }
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
function formatDepsResult(deps) {
  if (!deps?.attempted)
    return null;
  const sources = deps.sources.length ? deps.sources.join(", ") : "dependencies";
  if (deps.ok) {
    return { level: "info", text: `Installed Python dependencies (${sources}).` };
  }
  return {
    level: "warn",
    text: `Dependency install failed (${sources})${deps.error ? `: ${deps.error}` : ""} — install them manually before restarting.`
  };
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
    const r = fuzzyRank(q, [pack.name, pack.remote_url ?? null, pack.author || null]);
    if (r)
      scored.push({ pack, score: r.score, primaryMatches: r.primaryMatches });
  }
  scored.sort((a, b) => b.score - a.score || a.pack.name.localeCompare(b.pack.name));
  return scored.map(({ pack, primaryMatches }) => ({ pack, primaryMatches }));
}
function hoistPacksWithUpdates(ranked, hasUpdate) {
  const withUpdate = [];
  const withoutUpdate = [];
  for (const entry of ranked) {
    (hasUpdate(entry.pack.name) ? withUpdate : withoutUpdate).push(entry);
  }
  return [...withUpdate, ...withoutUpdate];
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
var STYLE_ID4 = "touch-manager-style";
var CSS4 = `
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
function depsToastDetail(deps) {
  const d = formatDepsResult(deps);
  if (!d)
    return "Restart ComfyUI to apply.";
  return d.level === "warn" ? d.text : `${d.text} Restart ComfyUI to apply.`;
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
    ensureStyleOnce(STYLE_ID4, CSS4);
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
    sweep: null,
    search: { installed: "" },
    rowByName: new Map
  };
  const tabBar = el("div", "tm-tabs");
  const tabs = [
    { id: "installed", label: "Installed" },
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
  const row = state.shell.searchEl.parentElement;
  if (row)
    row.style.display = onInstalled ? "" : "none";
  if (onInstalled) {
    state.shell.searchEl.placeholder = "Filter installed packs…";
    state.shell.searchEl.value = state.search.installed;
  }
}
function markRestartPending(state) {
  state.restartPending = true;
  const body = state.shell.bodyEl;
  if (!body.querySelector(".tm-restart"))
    body.prepend(restartBanner(state));
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
  if (!state.sweep)
    startUpdateSweep(state);
}
function renderInstalledList(state) {
  const section = resetBody(state);
  section.appendChild(installedHead(state));
  const query = state.shell.searchEl.value;
  const ranked = hoistPacksWithUpdates(filterPacks(query, state.installed), (name) => state.sweep?.results.get(name)?.update_available === true);
  state.shell.setStatus(`${ranked.length}/${state.installed.length}`);
  state.rowByName = new Map;
  if (ranked.length === 0) {
    section.appendChild(emptyState(state.installed.length === 0 ? "No packs found." : "No matches."));
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
function installedHead(state) {
  const head = el("div", "tm-installed-head");
  const sweeping = !!state.sweep && !state.sweep.complete;
  const recheck = button("Re-check updates", "", () => void startUpdateSweep(state));
  recheck.disabled = sweeping;
  head.appendChild(recheck);
  head.appendChild(el("div", "tm-row-meta tm-sweep-label", sweepLabel(state)));
  return head;
}
function sweepLabel(state) {
  const s = state.sweep;
  if (!s)
    return "";
  if (!s.complete)
    return `Checking for updates… ${s.results.size}/${s.total}`;
  const { actionable } = partitionUpdateResults([...s.results.values()]);
  if (actionable.length === 0)
    return "All up to date";
  return `${actionable.length} update${actionable.length === 1 ? "" : "s"} available`;
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
  else if (pack.source === "registry") {
    metaBits.push(`registry pack${pack.installed_version ? ` v${pack.installed_version}` : ""}`);
  } else
    metaBits.push("not a git repo");
  if (pack.dirty)
    metaBits.push("local changes");
  if (pack.author)
    metaBits.push(`by ${pack.author}`);
  row.appendChild(el("div", "tm-row-meta", metaBits.join(" · ")));
  if (pack.remote_url)
    row.appendChild(el("div", "tm-row-meta", pack.remote_url));
  row.appendChild(el("div", "tm-update-status"));
  const actions = el("div", "tm-row-actions");
  if (pack.enabled) {
    const updatable = pack.is_git || pack.source === "registry";
    const updateBtn = button("Update", "tm-update-btn", () => void doUpdate(state, pack.name, { origin: "installed" }));
    updateBtn.disabled = !updatable;
    if (!updatable)
      updateBtn.title = "not a git repo or registry-installed pack";
    actions.appendChild(updateBtn);
    const versionsBtn = button("Versions", "", () => void openVersions(state, pack));
    versionsBtn.disabled = !pack.is_git;
    if (!pack.is_git)
      versionsBtn.title = "not a git repo";
    actions.appendChild(versionsBtn);
    const forksBtn = button("Forks", "", () => void openForks(state, pack));
    forksBtn.disabled = !pack.is_git;
    if (!pack.is_git)
      forksBtn.title = "not a git repo";
    actions.appendChild(forksBtn);
    actions.appendChild(button("Disable", "tm-btn-danger", () => void doDisable(state, pack.name)));
  } else {
    actions.appendChild(button("Enable", "tm-btn-primary", () => void doEnable(state, pack.name)));
  }
  if (deletePermitted(state.config)) {
    actions.appendChild(button("Delete", "tm-btn-danger", () => void doDelete(state, pack)));
  }
  row.appendChild(actions);
  applyUpdateStatus(state, row, pack);
  return row;
}
function applyUpdateStatus(state, row, pack) {
  const status = row.querySelector(".tm-update-status");
  const updateBtn = row.querySelector(".tm-update-btn");
  if (!status)
    return;
  status.replaceChildren();
  row.classList.remove("tm-has-update");
  updateBtn?.classList.remove("tm-btn-primary");
  if (!pack.enabled)
    return;
  if (!pack.is_git && pack.source !== "registry")
    return;
  const info = state.sweep?.results.get(pack.name);
  if (!info) {
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
}
function removeFromUpdatesCache(state, name) {
  state.sweep?.results.delete(name);
}
async function refreshInstalledList(state) {
  const top = state.shell.bodyEl.scrollTop;
  try {
    const data = await apiGet("installed");
    state.installed = data.packs ?? [];
  } catch {
    return;
  }
  if (state.activeTab !== "installed")
    return;
  renderInstalledList(state);
  requestAnimationFrame(() => {
    state.shell.bodyEl.scrollTop = top;
  });
}
function confirmForceUpdate(state, name, fromDirty) {
  return confirmInShell(state.shell, {
    title: fromDirty ? "Pack has local changes" : "Update blocked by local changes",
    message: fromDirty ? `"${name}" has uncommitted local changes. Updating will DISCARD them ` + "(git checkout -f / reset --hard; untracked files are kept). Force the update?" : `Updating "${name}" was blocked — the working tree likely has local changes. ` + "Force the update and discard them?",
    confirmLabel: "Force update",
    danger: true,
    enterConfirms: true
  });
}
async function attemptUpdate(state, name, opts) {
  state.shell.setBusy(true);
  try {
    const body = { name };
    if (opts.ref)
      body.ref = opts.ref;
    if (opts.force)
      body.force = true;
    const result = await apiPost("update", body);
    markRestartPending(state);
    removeFromUpdatesCache(state, name);
    const deps = formatDepsResult(result.deps);
    toast(deps?.level === "warn" ? "warn" : "success", `Updated ${name}`, deps ? `${formatUpdateSummary(result)} — ${deps.text}` : formatUpdateSummary(result));
    if (opts.origin === "installed") {
      await refreshInstalledList(state);
    }
    return null;
  } catch (e) {
    const err = e;
    if (err.code === "checkout_failed" && !opts.force)
      return "checkout_failed";
    toast("error", `Update failed: ${name}`, `${err.message}${err.code ? ` (${err.code})` : ""}`);
    return err.code ?? "error";
  } finally {
    state.shell.setBusy(false);
  }
}
async function doUpdate(state, name, opts = {}) {
  const pack = state.installed.find((p) => p.name === name);
  let force = opts.force ?? false;
  if (!force && pack?.is_git && pack.dirty) {
    if (!await confirmForceUpdate(state, name, true))
      return;
    force = true;
  }
  const code = await attemptUpdate(state, name, { ...opts, force });
  if (code === "checkout_failed" && !force) {
    if (await confirmForceUpdate(state, name, false)) {
      await attemptUpdate(state, name, { ...opts, force: true });
    }
  }
}
async function doDisable(state, name) {
  const ok = await confirmInShell(state.shell, {
    title: "Disable pack?",
    message: `Disable "${name}"? The directory is renamed to "${name}.disabled" (reversible — re-enable it from its row), not deleted. A restart is required.`,
    confirmLabel: "Disable",
    danger: true,
    enterConfirms: true
  });
  if (!ok)
    return;
  state.shell.setBusy(true);
  try {
    await apiPost("uninstall", { name });
    markRestartPending(state);
    state.sweep = null;
    toast("success", `Disabled ${name}`, "Restart ComfyUI to apply.");
    await renderInstalledTab(state);
  } catch (e) {
    const err = e;
    toast("error", `Disable failed: ${name}`, `${err.message}${err.code ? ` (${err.code})` : ""}`);
  } finally {
    state.shell.setBusy(false);
  }
}
async function doEnable(state, name) {
  state.shell.setBusy(true);
  try {
    await apiPost("enable", { name });
    markRestartPending(state);
    state.sweep = null;
    toast("success", `Enabled ${name}`, "Restart ComfyUI to apply.");
    await renderInstalledTab(state);
  } catch (e) {
    const err = e;
    toast("error", `Enable failed: ${name}`, `${err.message}${err.code ? ` (${err.code})` : ""}`);
  } finally {
    state.shell.setBusy(false);
  }
}
async function doDelete(state, pack) {
  const ok = await confirmInShell(state.shell, {
    title: "Delete pack permanently?",
    message: `Permanently delete "${pack.name}" and everything in it, including any local ` + `changes? This CANNOT be undone.

${pack.path}

` + (pack.enabled ? "To remove it reversibly instead, cancel and use Disable. " : "This pack is already disabled — deleting frees its disk space. ") + "A restart is required.",
    confirmLabel: "Delete permanently",
    danger: true,
    enterConfirms: false
  });
  if (!ok)
    return;
  state.shell.setBusy(true);
  try {
    await apiPost("delete", { name: pack.name });
    markRestartPending(state);
    state.sweep = null;
    toast("success", `Deleted ${pack.name}`, "Restart ComfyUI to apply.");
    await renderInstalledTab(state);
  } catch (e) {
    const err = e;
    toast("error", `Delete failed: ${pack.name}`, `${err.message}${err.code ? ` (${err.code})` : ""}`);
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
var FORK_FILTER_THRESHOLD = 6;
async function openForks(state, pack) {
  const heading = () => [
    button("← Back to installed", "", () => void renderInstalledTab(state)),
    el("div", "tm-row-title", `Forks — ${pack.name}`)
  ];
  const section = resetBody(state);
  section.append(...heading(), emptyState("Loading forks…"));
  state.shell.setBusy(true);
  let data;
  try {
    data = await apiGet(`forks?name=${encodeURIComponent(pack.name)}`);
  } catch (e) {
    section.replaceChildren(...heading(), emptyState(`Failed: ${e.message}`));
    state.shell.setBusy(false);
    return;
  }
  state.shell.setBusy(false);
  const allowed = installPermitted(state.config);
  section.replaceChildren(...heading());
  section.appendChild(el("div", allowed ? "tm-note tm-note-info" : "tm-note tm-note-warn", allowed ? `Switching repoints "${pack.name}" at another repository. Its directory name and ` + "git history are kept — only the code it tracks changes. Python dependencies are " + "installed automatically; a restart is required. Only switch to code you trust." : "ComfyUI is bound to a non-loopback address, so the server refuses to switch a " + "pack's repository (set TOUCH_MANAGER_ALLOW_REMOTE_INSTALL=1 to allow)."));
  section.appendChild(el("div", "tm-field-label", "Current remote"));
  section.appendChild(el("div", "tm-row-meta", data.current ?? "no remote configured"));
  const entries = buildForkEntries(data);
  if (entries.length === 0) {
    section.appendChild(emptyState("No forks found — this pack is not on GitHub, has no forks, or the GitHub API is " + "unavailable. You can still enter a repository URL below."));
  } else {
    section.appendChild(el("div", "tm-field-label", "Upstream & forks"));
    const listHost = el("div", "tm-section");
    const paint = (query) => {
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
  const switchBtn = button("Switch to this repository", "tm-btn-primary", () => void doSwitchRemote(state, pack, urlInput.value.trim(), refInput.value.trim()));
  section.appendChild(switchBtn);
  const refresh = () => {
    if (!allowed) {
      switchBtn.disabled = true;
      hint.textContent = "Switching is disabled by the server bind policy.";
      return;
    }
    const v = validateInstallUrl(urlInput.value);
    switchBtn.disabled = !v.ok;
    hint.textContent = v.ok ? `Will track ${repoLabel(urlInput.value)}.` : urlInput.value.trim() ? urlValidationHint(v.reason) : "";
  };
  urlInput.addEventListener("input", refresh);
  refresh();
}
function forkList(state, pack, entries, query, allowed) {
  const rows = entries.map((entry) => ({
    name: entry.repo.full_name,
    remote_url: entry.repo.url,
    author: entry.repo.owner,
    entry
  }));
  const ranked = query.trim() ? filterPacks(query, rows) : rows.map((row) => ({ pack: row, primaryMatches: [] }));
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
function forkRow(state, pack, entry, matches, allowed) {
  const row = el("div", "tm-row");
  const head = el("div", "tm-row-head");
  head.appendChild(el("span", `tm-badge tm-badge-${entry.role}`, entry.role));
  const title = el("span", "tm-row-title");
  title.appendChild(highlightMatches(entry.repo.full_name, matches));
  head.appendChild(title);
  row.appendChild(head);
  row.appendChild(el("div", "tm-row-meta", formatForkMeta(entry.repo)));
  if (entry.repo.description)
    row.appendChild(el("div", "tm-row-meta", entry.repo.description));
  const actions = el("div", "tm-row-actions");
  if (entry.role === "current") {
    actions.appendChild(el("div", "tm-row-meta", "Already tracking this repository."));
  } else {
    const switchBtn = button("Switch", "tm-btn-primary", () => void doSwitchRemote(state, pack, entry.repo.url));
    switchBtn.disabled = !allowed;
    if (!allowed)
      switchBtn.title = "disabled by the server bind policy";
    actions.appendChild(switchBtn);
  }
  row.appendChild(actions);
  return row;
}
function confirmForceSwitch(state, name, fromDirty) {
  return confirmInShell(state.shell, {
    title: fromDirty ? "Pack has local changes" : "Switch blocked by local changes",
    message: fromDirty ? `"${name}" has uncommitted local changes. Switching repositories will DISCARD them ` + "(untracked files are kept). Continue?" : `Switching "${name}" was refused — the working tree has local changes. ` + "Discard them (untracked files are kept) and switch anyway?",
    confirmLabel: "Discard and switch",
    danger: true,
    enterConfirms: true
  });
}
async function attemptRemoteSwitch(state, pack, url, ref, force) {
  state.shell.setBusy(true);
  try {
    const body = { name: pack.name, url };
    if (ref)
      body.ref = ref;
    if (force)
      body.force = true;
    const result = await apiPost("remote", body);
    markRestartPending(state);
    state.sweep = null;
    const deps = formatDepsResult(result.deps);
    toast(deps?.level === "warn" ? "warn" : "success", `Switched ${pack.name}`, deps ? `${formatRemoteSwitchSummary(result)} — ${deps.text}` : formatRemoteSwitchSummary(result));
    await renderInstalledTab(state);
    return null;
  } catch (e) {
    const err = e;
    if (err.code === "dirty" && !force)
      return "dirty";
    toast("error", `Switch failed: ${pack.name}`, `${err.message}${err.code ? ` (${err.code})` : ""}`);
    return err.code ?? "error";
  } finally {
    state.shell.setBusy(false);
  }
}
async function doSwitchRemote(state, pack, url, ref = "") {
  const target = repoLabel(url) || url;
  const ok = await confirmInShell(state.shell, {
    title: "Switch to a different fork?",
    message: `Point "${pack.name}" at ${target}${ref ? ` @ ${ref}` : ""}? Its directory name and git ` + "history are kept; the code it tracks is replaced. Only switch to code you trust. " + "A restart is required.",
    confirmLabel: "Switch",
    danger: true,
    enterConfirms: true
  });
  if (!ok)
    return;
  let force = false;
  if (pack.dirty) {
    if (!await confirmForceSwitch(state, pack.name, true))
      return;
    force = true;
  }
  const code = await attemptRemoteSwitch(state, pack, url, ref, force);
  if (code === "dirty" && !force && await confirmForceSwitch(state, pack.name, false)) {
    await attemptRemoteSwitch(state, pack, url, ref, true);
  }
}
var UPDATE_CHECK_CONCURRENCY = 3;
function refreshSweepHead(state) {
  const body = state.shell.bodyEl;
  const label = body.querySelector(".tm-sweep-label");
  if (label)
    label.textContent = sweepLabel(state);
  const recheck = body.querySelector(".tm-installed-head .tm-btn");
  if (recheck)
    recheck.disabled = !!state.sweep && !state.sweep.complete;
}
function patchRow(state, name) {
  const row = state.rowByName.get(name);
  if (!row)
    return;
  const pack = state.installed.find((p) => p.name === name);
  if (pack)
    applyUpdateStatus(state, row, pack);
}
async function startUpdateSweep(state) {
  const sweep = {
    token: {},
    results: new Map,
    total: 0,
    checkedAt: Date.now(),
    complete: false
  };
  state.sweep = sweep;
  if (state.activeTab === "installed")
    repaintUpdateStatuses(state);
  let names;
  try {
    const data = await apiGet("updates/list");
    names = (data.packs ?? []).map((p) => p.name);
  } catch {
    if (state.sweep !== sweep)
      return;
    sweep.complete = true;
    if (state.activeTab === "installed")
      refreshSweepHead(state);
    return;
  }
  if (state.sweep !== sweep)
    return;
  sweep.total = names.length;
  if (names.length === 0) {
    sweep.complete = true;
    if (state.activeTab === "installed")
      repaintUpdateStatuses(state);
    return;
  }
  if (state.activeTab === "installed")
    refreshSweepHead(state);
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
          source: "unknown",
          update_available: false,
          behind: 0,
          ahead: 0,
          error: e.message,
          incoming: [],
          latest_version: null
        };
      }
      if (state.sweep !== sweep)
        return;
      sweep.results.set(name, info);
      if (state.activeTab === "installed") {
        patchRow(state, name);
        refreshSweepHead(state);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(UPDATE_CHECK_CONCURRENCY, names.length) }, () => worker()));
  if (state.sweep !== sweep)
    return;
  sweep.complete = true;
  if (state.activeTab === "installed")
    renderInstalledList(state);
}
function repaintUpdateStatuses(state) {
  for (const [name, row] of state.rowByName) {
    const pack = state.installed.find((p) => p.name === name);
    if (pack)
      applyUpdateStatus(state, row, pack);
  }
  refreshSweepHead(state);
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
  const ok = await confirmInShell(state.shell, {
    title: "Install pack?",
    message: `Clone ${url.trim()} into custom_nodes as "${v.name}"? Only install code you trust. A restart is required.`,
    confirmLabel: "Install",
    enterConfirms: true
  });
  if (!ok)
    return;
  state.shell.setBusy(true);
  try {
    const body = { url: url.trim() };
    if (ref.trim())
      body.ref = ref.trim();
    const res = await apiPost("install", body);
    markRestartPending(state);
    state.sweep = null;
    const level = res.deps.attempted && res.deps.ok === false ? "warn" : "success";
    toast(level, `Installed ${res.name}`, depsToastDetail(res.deps));
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
  section.appendChild(el("div", "tm-note tm-note-info", "Search the Comfy Registry and install a node. Python dependencies are " + "installed automatically; a restart is required afterwards."));
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
  const ok = await confirmInShell(state.shell, {
    title: "Install from registry?",
    message: `Download and install ${label} from the Comfy Registry into custom_nodes? ` + "Only install code you trust. A restart is required.",
    confirmLabel: "Install",
    enterConfirms: true
  });
  if (!ok)
    return;
  state.shell.setBusy(true);
  try {
    const body = { id: node.id, name: node.id };
    if (version)
      body.version = version;
    const res = await apiPost("registry/install", body);
    markRestartPending(state);
    state.sweep = null;
    const level = res.deps.attempted && res.deps.ok === false ? "warn" : "success";
    toast(level, `Installed ${res.name}${res.version ? `@${res.version}` : ""}`, depsToastDetail(res.deps));
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
  section.appendChild(el("div", "tm-note tm-note-info", "Runs git pull on the core repo and installs any changed Python dependencies. Restart ComfyUI yourself afterwards."));
}
var reloadController = {
  reload() {
    window.location.reload();
  }
};
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function probeServer() {
  try {
    const res = await app.api.fetchApi(app.api.apiURL("/touch_manager/config"), {
      cache: "no-store"
    });
    return res.ok === true;
  } catch {
    return false;
  }
}
function startReloadCountdown(status, actions) {
  let remaining = RECONNECT_POLL.countdownSeconds;
  let cancelled = false;
  const tick = () => {
    if (cancelled)
      return;
    if (remaining <= 0) {
      reloadController.reload();
      return;
    }
    status.textContent = `ComfyUI is back — reloading in ${remaining}…`;
    remaining -= 1;
    setTimeout(tick, 1000);
  };
  actions.replaceChildren();
  actions.appendChild(button("Reload now", "tm-btn-primary", () => {
    cancelled = true;
    reloadController.reload();
  }));
  actions.appendChild(button("Cancel", "", () => {
    cancelled = true;
    status.textContent = "ComfyUI is back. Reload when you're ready.";
  }));
  tick();
}
async function watchForReconnect(state, watch) {
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
      if (watch.cancelled)
        return;
      startReloadCountdown(status, actions);
      return;
    }
    if (watch.cancelled)
      return;
    status.textContent = formatReconnectStatus(Date.now() - start);
    await sleep(RECONNECT_POLL.intervalMs);
  }
  if (!watch.cancelled) {
    status.textContent = formatReconnectStatus(RECONNECT_POLL.timeoutMs);
  }
}
async function doReboot(state) {
  const ok = await confirmInShell(state.shell, {
    title: "Restart ComfyUI?",
    message: "Restart the ComfyUI server now to apply changes? The server will be briefly unavailable, then this page reloads automatically once it is back.",
    confirmLabel: "Restart now",
    danger: true,
    enterConfirms: true
  });
  if (!ok)
    return;
  toast("info", "Restarting ComfyUI…", "The page will reload automatically once it is back.", 8000);
  const watch = { cancelled: false };
  watchForReconnect(state, watch);
  try {
    await apiPost("reboot", {});
  } catch (e) {
    if (e instanceof ManagerError) {
      watch.cancelled = true;
      toast("error", "Restart failed", `${e.message}${e.code ? ` (${e.code})` : ""}`);
      await renderCoreTab(state);
    }
  }
}
async function doCoreUpdate(state) {
  const ok = await confirmInShell(state.shell, {
    title: "Update ComfyUI core?",
    message: "Run git pull on the core repo? Python dependencies are installed automatically when they change; a manual restart is required afterwards.",
    confirmLabel: "Update core",
    enterConfirms: true
  });
  if (!ok)
    return;
  state.shell.setBusy(true);
  try {
    const res = await apiPost("core/update", {});
    markRestartPending(state);
    const level = res.deps.attempted && res.deps.ok === false ? "warn" : "success";
    toast(level, "Core updated", depsToastDetail(res.deps));
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
var launcher = makeLauncher({
  id: "touch-manager.open",
  label: "Touch Node Manager",
  icon: "pi pi-th-large",
  failSummary: "Could not open Touch Node Manager",
  open: openManager
});
var safeOpen = launcher.commands[0]?.function ?? openManager;
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
  ...launcher,
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
          if (!document.querySelector(".cmp-dialog"))
            safeOpen();
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
  hoistPacksWithUpdates,
  formatUpdateStatus,
  formatRef,
  filterPacks
};
