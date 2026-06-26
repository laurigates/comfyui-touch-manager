// Pure helpers for the Touch Node Manager — NO DOM access here.
//
// Everything in this module is a pure function or a data-shape type, so the
// Vitest suite can import and exercise it directly without jsdom. The two
// classes of logic that MUST stay in sync with the Python backend are:
//   1. install-URL validation (mirror of touch_manager.py's URL gate), and
//   2. the data shapes returned by the /touch_manager/* routes.
// The DOM-bound rendering lives in touch-manager-ui.ts.
//
// `fuzzyRank` from the modal kit is pure (no DOM — only `highlightMatches`
// touches the document), so the fuzzy-filter glue belongs here and is unit
// testable.
import { fuzzyRank } from "@laurigates/comfy-modal-kit";

// ============================================================
// Backend response shapes (mirror touch_manager.py JSON)
// ============================================================

/** A resolved git ref: {type, name, sha}. */
export interface GitRef {
  type: "branch" | "tag" | "detached";
  name: string | null;
  sha: string | null;
}

/** One row of GET /touch_manager/installed. */
export interface InstalledPack {
  name: string;
  path: string;
  root: string;
  is_git: boolean;
  ref: GitRef;
  remote_url: string | null;
  dirty: boolean;
  enabled: boolean;
}

/** One row of GET /touch_manager/updates. */
export interface UpdateInfo {
  name: string;
  update_available: boolean;
  behind: number;
  ahead: number;
  error: string | null;
}

/** One applied commit in an UpdateResult log. */
export interface CommitLogEntry {
  sha: string;
  subject: string;
}

/** The change detail returned by POST /touch_manager/update. */
export interface UpdateResult {
  name: string;
  before_short: string | null;
  after_short: string | null;
  commits_applied: number;
  commit_log: CommitLogEntry[];
  changed_files: number;
  deps_changed: boolean;
  truncated: boolean;
}

/** One row of GET /touch_manager/updates/list. */
export interface UpdatesListEntry {
  name: string;
}

/** GET /touch_manager/updates/check?name=<pack> — per-pack result. */
export interface UpdateCheckResult extends UpdateInfo {
  /** Short preview of the commits an update would bring (may be empty). */
  incoming: CommitLogEntry[];
}

/** Progress label for the incremental update check, e.g. "checked 3/12". */
export function formatProgress(done: number, total: number): string {
  return `checked ${done}/${total}`;
}

/** Split per-pack check results into the three buckets the UI renders. */
export function partitionUpdateResults(results: readonly UpdateCheckResult[]): {
  actionable: UpdateCheckResult[];
  errored: UpdateCheckResult[];
  upToDate: UpdateCheckResult[];
} {
  const actionable: UpdateCheckResult[] = [];
  const errored: UpdateCheckResult[] = [];
  const upToDate: UpdateCheckResult[] = [];
  for (const r of results) {
    if (r.error) errored.push(r);
    else if (r.update_available) actionable.push(r);
    else upToDate.push(r);
  }
  return { actionable, errored, upToDate };
}

/** One release of GET /touch_manager/versions. */
export interface ReleaseInfo {
  tag: string;
  name: string;
  published_at: string;
  prerelease: boolean;
}

/** GET /touch_manager/versions?name=<pack>. */
export interface VersionsInfo {
  name: string;
  branches: string[];
  tags: string[];
  releases: ReleaseInfo[];
}

// ============================================================
// Comfy Registry shapes + helpers
// ============================================================

/** One node in GET /touch_manager/registry/search. */
export interface RegistryNode {
  id: string;
  name: string;
  description: string;
  author: string;
  downloads: number;
  icon: string;
  repository: string;
  latest_version: string | null;
  publisher: string | null;
}

/** GET /touch_manager/registry/search. */
export interface RegistrySearchResult {
  page: number;
  total_pages: number;
  nodes: RegistryNode[];
}

/** One version in GET /touch_manager/registry/versions. */
export interface RegistryVersion {
  version: string;
  deprecated: boolean;
  createdAt?: string | null;
}

/** POST /touch_manager/registry/install. */
export interface RegistryInstallResult {
  name: string;
  version: string | null;
  source: "registry";
  deps_changed: boolean;
}

/** A unified version-picker entry — either a git ref or a registry version. */
export interface VersionEntry {
  kind: "git" | "registry";
  label: string;
  /** git ref to check out (kind "git"). */
  ref?: string;
  /** registry version to install (kind "registry"). */
  version?: string;
  /** optional secondary line (e.g. "deprecated"). */
  meta?: string;
}

/**
 * Build one ordered list mixing git refs and registry versions for the version
 * picker. Git refs (branches then tags, deduped via versionOptions) come first,
 * then registry versions — each tagged with `kind` so the UI can show a
 * distinguishing icon. Either source may be empty.
 */
export function mergeVersionEntries(
  gitInfo: Pick<VersionsInfo, "branches" | "tags"> | null,
  registryVersions: readonly RegistryVersion[],
): VersionEntry[] {
  const out: VersionEntry[] = [];
  if (gitInfo) {
    for (const ref of versionOptions(gitInfo)) out.push({ kind: "git", label: ref, ref });
  }
  for (const v of registryVersions) {
    out.push({
      kind: "registry",
      label: v.version,
      version: v.version,
      meta: v.deprecated ? "deprecated" : undefined,
    });
  }
  return out;
}

/** Short source tag for a version entry, shown as a badge next to it. */
export function iconForKind(kind: VersionEntry["kind"]): string {
  return kind === "git" ? "git" : "registry";
}

/** Compact download count, e.g. 1234 -> "1.2k", 2_500_000 -> "2.5M". */
export function formatDownloads(n: number | null | undefined): string {
  const v = typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(v);
}

/** Defensive normaliser for a registry node (the backend already trims). */
export function normalizeRegistryNode(raw: Partial<RegistryNode> & { id: string }): RegistryNode {
  return {
    id: raw.id,
    name: raw.name || raw.id,
    description: raw.description ?? "",
    author: raw.author ?? "",
    downloads: typeof raw.downloads === "number" ? raw.downloads : 0,
    icon: raw.icon ?? "",
    repository: raw.repository ?? "",
    latest_version: raw.latest_version ?? null,
    publisher: raw.publisher ?? null,
  };
}

/** One-line meta for a registry search row: author · downloads · version. */
export function formatRegistryMeta(node: RegistryNode): string {
  const parts: string[] = [];
  if (node.author) parts.push(node.author);
  parts.push(`${formatDownloads(node.downloads)} downloads`);
  if (node.latest_version) parts.push(`v${node.latest_version}`);
  return parts.join(" · ");
}

/** GET /touch_manager/config. */
export interface ManagerConfig {
  allow_remote_install: boolean;
  is_loopback: boolean;
  manager_enabled: boolean;
  reboot_allowed: boolean;
}

/**
 * Whether the Install-from-URL action should be enabled, mirroring the backend
 * /install gate exactly: it allows the clone when the server is bound to a
 * loopback address OR the operator set TOUCH_MANAGER_ALLOW_REMOTE_INSTALL=1
 * (reported as `allow_remote_install`). `allow_remote_install` alone is only
 * the non-loopback override — gating on it would wrongly disable install on the
 * normal loopback setup. With no config yet, default to enabled and let the
 * backend (the real gate) decide.
 */
export function installPermitted(config: ManagerConfig | null): boolean {
  if (!config) return true;
  return config.is_loopback || config.allow_remote_install;
}

/**
 * Whether the Restart-ComfyUI control should be shown, reflecting the backend
 * /reboot gate (loopback by default, or the TOUCH_MANAGER_ALLOW_REMOTE_REBOOT
 * opt-in, reported as `reboot_allowed`). Unlike install, this defaults to
 * HIDDEN until config loads — surfacing a restart button that the backend would
 * reject is worse than briefly hiding an available one.
 */
export function rebootPermitted(config: ManagerConfig | null): boolean {
  return config ? config.reboot_allowed : false;
}

/** GET /touch_manager/core. */
export interface CoreInfo {
  is_git: boolean;
  ref: GitRef;
  behind: { origin: number | null; upstream: number | null };
  dirty: boolean;
  remotes: { origin: string | null; upstream: string | null };
}

// ============================================================
// Install-URL validation — mirror of the backend gate
// ============================================================

/**
 * Hosts the backend accepts for /install. Keep in lockstep with
 * touch_manager.py: github.com / gitlab.com only.
 */
const ALLOWED_INSTALL_HOSTS: ReadonlySet<string> = new Set(["github.com", "gitlab.com"]);

interface UrlValidationOk {
  ok: true;
  /** Sanitized target directory name (last path segment minus `.git`). */
  name: string;
  host: string;
  owner: string;
}

interface UrlValidationErr {
  ok: false;
  code: "invalid_url";
  /** Machine-readable sub-reason, for surfacing a precise hint. */
  reason:
    | "empty"
    | "unparseable"
    | "not_https"
    | "host_not_allowed"
    | "missing_owner_repo"
    | "bad_name";
}

type UrlValidationResult = UrlValidationOk | UrlValidationErr;

/**
 * Sanitize a candidate directory name to the backend's allowed alphabet
 * (`[A-Za-z0-9._-]`). Returns "" for anything that would be rejected: an empty
 * result, a lone "." / "..", or a name containing a path separator.
 *
 * Mirrors the backend's name guard so the frontend can disable Install before
 * a round-trip rather than surfacing a server error.
 */
export function sanitizePackName(raw: string): string {
  if (raw.includes("/") || raw.includes("\\")) return "";
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, "");
  if (cleaned === "" || cleaned === "." || cleaned === "..") return "";
  return cleaned;
}

/**
 * Validate an install URL the same way the backend does, and derive the
 * target directory name. https + github.com/gitlab.com only, optional trailing
 * `.git`. This is a client-side mirror; the backend re-validates and is the
 * real gate (it also enforces the bind gate and path-traversal guard).
 */
export function validateInstallUrl(rawUrl: string): UrlValidationResult {
  const url = (rawUrl ?? "").trim();
  if (!url) return { ok: false, code: "invalid_url", reason: "empty" };

  let parsed: URL;
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
  if (last.endsWith(".git")) last = last.slice(0, -4);

  const name = sanitizePackName(last);
  if (!name) return { ok: false, code: "invalid_url", reason: "bad_name" };

  return { ok: true, name, host, owner };
}

/** Human-readable hint for a URL validation failure. */
export function urlValidationHint(reason: UrlValidationErr["reason"]): string {
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

// ============================================================
// Version-label formatting
// ============================================================

/** Short 7-char form of a commit sha, or "" when absent. */
function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : "";
}

/** Format a {type, name, sha} ref into a compact label. */
export function formatRef(ref: GitRef | null | undefined): string {
  if (!ref) return "unknown";
  const sha = shortSha(ref.sha);
  if (ref.type === "detached") return sha ? `detached @ ${sha}` : "detached";
  if (ref.name) return sha ? `${ref.name} @ ${sha}` : ref.name;
  return sha || ref.type;
}

/** One-line update status for an Updates-tab row. */
export function formatUpdateStatus(info: UpdateInfo): string {
  if (info.error) return `error: ${info.error}`;
  if (info.update_available) {
    const parts: string[] = [];
    if (info.behind > 0) parts.push(`${info.behind} behind`);
    if (info.ahead > 0) parts.push(`${info.ahead} ahead`);
    return parts.length ? `update available — ${parts.join(", ")}` : "update available";
  }
  if (info.ahead > 0) return `${info.ahead} ahead (local commits)`;
  return "up to date";
}

/**
 * One-line summary of what an update applied: short SHA transition, commit
 * count, and changed-file count. Collapses to "already up to date" when the
 * pack was already at the target (no commits applied).
 */
export function formatUpdateSummary(r: UpdateResult): string {
  if (r.commits_applied === 0) return "Already up to date — nothing to apply.";
  const parts: string[] = [];
  if (r.before_short && r.after_short) parts.push(`${r.before_short} → ${r.after_short}`);
  const commits = `${r.commits_applied} commit${r.commits_applied === 1 ? "" : "s"}`;
  parts.push(r.truncated ? `${commits} (log truncated)` : commits);
  if (r.changed_files > 0) {
    parts.push(`${r.changed_files} file${r.changed_files === 1 ? "" : "s"} changed`);
  }
  return parts.join(" · ");
}

/** Warning string when an update changed requirements.txt, else null. */
export function formatDepsWarning(r: UpdateResult): string | null {
  return r.deps_changed
    ? "requirements.txt changed — install Python dependencies manually, then restart."
    : null;
}

/** Compact "<short> <subject>" line for a single applied commit. */
export function formatCommitLine(entry: CommitLogEntry): string {
  return `${entry.sha} ${entry.subject}`.trim();
}

/** Format core-repo behind counts ({origin, upstream}) into a label. */
export function formatCoreBehind(behind: CoreInfo["behind"]): string {
  const parts: string[] = [];
  if (behind.origin != null && behind.origin > 0) parts.push(`${behind.origin} behind origin`);
  if (behind.upstream != null && behind.upstream > 0)
    parts.push(`${behind.upstream} behind upstream`);
  return parts.length ? parts.join(", ") : "up to date";
}

// ============================================================
// Ref / version sorting
// ============================================================

const PREFERRED_BRANCHES = ["main", "master", "develop"];

/** Parse a semver-ish tag (`v1.2.3`, `1.2`, `2`) into a numeric tuple, or null. */
function parseSemver(tag: string): [number, number, number] | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(tag.trim());
  if (!m) return null;
  return [Number(m[1] ?? 0), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

/**
 * Compare two tags so a sort() yields newest-first. Semver tags sort
 * descending by version; non-semver tags sort after all semver tags,
 * alphabetically ascending.
 */
function compareTagsDesc(a: string, b: string): number {
  const sa = parseSemver(a);
  const sb = parseSemver(b);
  if (sa && sb) {
    for (let i = 0; i < 3; i++) {
      const diff = (sb[i] ?? 0) - (sa[i] ?? 0);
      if (diff !== 0) return diff;
    }
    return a.localeCompare(b);
  }
  if (sa) return -1; // semver before non-semver
  if (sb) return 1;
  return a.localeCompare(b);
}

/** Sort branches: preferred (main/master/develop) first, then alphabetical. */
export function sortBranches(branches: readonly string[]): string[] {
  return [...branches].sort((a, b) => {
    const ia = PREFERRED_BRANCHES.indexOf(a);
    const ib = PREFERRED_BRANCHES.indexOf(b);
    if (ia !== -1 || ib !== -1) {
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    }
    return a.localeCompare(b);
  });
}

/** Sort tags newest-first (semver descending, non-semver alphabetical after). */
export function sortTags(tags: readonly string[]): string[] {
  return [...tags].sort(compareTagsDesc);
}

/**
 * Build the ordered ref list for a version picker: preferred branches first,
 * then remaining branches, then newest tags. Deduplicated, preserving order.
 */
export function versionOptions(info: Pick<VersionsInfo, "branches" | "tags">): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ref of [...sortBranches(info.branches), ...sortTags(info.tags)]) {
    if (seen.has(ref)) continue;
    seen.add(ref);
    out.push(ref);
  }
  return out;
}

// ============================================================
// Fuzzy-filter glue (over [name, remote_url])
// ============================================================

/** A pack plus the fuzzy match indices on its primary (name) field. */
interface RankedPack<T> {
  pack: T;
  /** Indices into `pack.name` that matched, for highlighting. */
  primaryMatches: number[];
}

/**
 * Fuzzy-rank a pack list against a query over [name, remote_url]. An empty
 * query returns every pack (no matches), sorted by name ascending. A non-empty
 * query returns only matching packs, best score first, carrying the
 * primary-field match indices for highlighting.
 */
export function filterPacks<T extends { name: string; remote_url?: string | null }>(
  query: string,
  packs: readonly T[],
): RankedPack<T>[] {
  const q = query.trim();
  if (!q) {
    return [...packs]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((pack) => ({ pack, primaryMatches: [] }));
  }
  const scored: Array<{ pack: T; score: number; primaryMatches: number[] }> = [];
  for (const pack of packs) {
    const r = fuzzyRank(q, [pack.name, pack.remote_url ?? null]);
    if (r) scored.push({ pack, score: r.score, primaryMatches: r.primaryMatches });
  }
  scored.sort((a, b) => b.score - a.score || a.pack.name.localeCompare(b.pack.name));
  return scored.map(({ pack, primaryMatches }) => ({ pack, primaryMatches }));
}
