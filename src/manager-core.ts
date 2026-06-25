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

/** GET /touch_manager/config. */
export interface ManagerConfig {
  allow_remote_install: boolean;
  is_loopback: boolean;
  manager_enabled: boolean;
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
