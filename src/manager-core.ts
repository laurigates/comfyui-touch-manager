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

/**
 * How a pack got onto disk: a git checkout (fetch/checkout-based updates), a
 * Comfy Registry archive extraction (version-compare-based updates, no git
 * remote to fetch), or a plain directory this manager cannot update.
 */
type PackSource = "git" | "registry" | "unknown";

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
  /** Git remote owner, else the registry PublisherId, else "". */
  author: string;
  source: PackSource;
  /** The Comfy Registry node id (== pyproject `[project.name]`) when `source` is "registry". */
  registry_id: string | null;
  /** The pyproject `[project.version]` currently on disk when `source` is "registry". */
  installed_version: string | null;
  /** One-line summary read from the pack's own files; "" when it describes itself nowhere. */
  description: string;
  /** Which file `description` came from, so an authored summary is distinguishable
   * from a scraped README line. "" when there is no description. */
  description_source: DescriptionSource;
  /** Nodes this pack registered in the RUNNING install. `null` means "unknown"
   * (disabled pack, or a ComfyUI without node provenance) — never render it as 0. */
  node_count: number | null;
  /** Top-level categories those nodes register under, most-used first (max 3). */
  node_categories: string[];
}

/** Which file a pack's description was read from ("" when none resolved). */
export type DescriptionSource = "pyproject" | "package.json" | "readme" | "";

/** One row of GET /touch_manager/updates. */
export interface UpdateInfo {
  name: string;
  source: PackSource;
  update_available: boolean;
  behind: number;
  ahead: number;
  error: string | null;
  /** The registry's latest published version, when `source` is "registry". */
  latest_version: string | null;
}

/** One applied commit in an UpdateResult log. */
interface CommitLogEntry {
  sha: string;
  subject: string;
}

/**
 * The result of a backend pip dependency install, attached by every route that
 * lands new code (install, update, core/update, registry/install). `attempted`
 * is false — and `ok` null — when the operation touched no dependency file.
 */
export interface DepsResult {
  attempted: boolean;
  ok: boolean | null;
  sources: string[];
  error: string | null;
  log: string;
}

/** The change detail returned by POST /touch_manager/update. */
export interface UpdateResult {
  name: string;
  source: PackSource;
  before_short: string | null;
  after_short: string | null;
  /** Registry version transition (populated when `source` is "registry"). */
  before_version: string | null;
  after_version: string | null;
  commits_applied: number;
  commit_log: CommitLogEntry[];
  changed_files: number;
  deps_changed: boolean;
  deps: DepsResult;
  truncated: boolean;
}

/** POST /touch_manager/install (git clone). */
export interface InstallResult {
  name: string;
  deps: DepsResult;
}

/** POST /touch_manager/core/update. */
export interface CoreUpdateResult {
  deps_changed: boolean;
  deps: DepsResult;
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
interface ReleaseInfo {
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
  deps: DepsResult;
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
  /**
   * Repository this entry's label names, when the label IS a repo URL (the
   * synthetic "install the default branch" row). Carried separately so the UI
   * can build an href without re-parsing the label prose around it.
   */
  repository?: string;
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

/** Compact count (downloads, stars…), e.g. 1234 -> "1.2k", 2_500_000 -> "2.5M". */
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

/**
 * One-line summary of what a pack contributes to the running install, e.g.
 * "197 nodes · ImpactPack" or "1 node". Returns "" when the count is unknown
 * (`null`) — a disabled pack, a frontend-only pack that registers nothing, or
 * a ComfyUI that does not stamp node provenance. Rendering "0 nodes" for any
 * of those would assert something the backend did not measure.
 */
export function formatNodeSummary(
  pack: Pick<InstalledPack, "node_count" | "node_categories">,
): string {
  const count = pack.node_count;
  if (typeof count !== "number" || count <= 0) return "";
  const parts = [`${count} node${count === 1 ? "" : "s"}`];
  const categories = pack.node_categories.filter((c) => c.trim().length > 0);
  if (categories.length) parts.push(categories.join(", "));
  return parts.join(" · ");
}

/** GET /touch_manager/config. */
export interface ManagerConfig {
  allow_remote_install: boolean;
  is_loopback: boolean;
  manager_enabled: boolean;
  reboot_allowed: boolean;
  delete_allowed: boolean;
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

/**
 * Whether the permanent-Delete action should be offered, reflecting the backend
 * /delete gate (loopback by default, or the TOUCH_MANAGER_ALLOW_REMOTE_DELETE
 * opt-in, reported as `delete_allowed`). Like reboot — and unlike install — this
 * defaults to HIDDEN until config loads: an irreversible button the backend
 * would refuse is worse than a briefly missing one.
 */
export function deletePermitted(config: ManagerConfig | null): boolean {
  return config ? config.delete_allowed : false;
}

/**
 * One line of live delete-gate status for the Settings dialog, derived from
 * the config the backend reported — never from a stored setting, which could
 * sit there claiming delete is enabled while the server refuses.
 *
 * The branches mirror `_delete_allowed()` in touch_manager.py, which is
 * `_is_loopback(listen) or TOUCH_MANAGER_ALLOW_REMOTE_DELETE == "1"`. That
 * makes "refused" imply "not loopback", so the refusal line can name the bind
 * as the cause; the trailing branch exists only so a backend that ever
 * decouples the two does not get misreported here.
 */
export function deleteGateStatusText(config: ManagerConfig | null): string {
  if (!config) return "Unavailable — could not read the server's manager config.";
  if (config.delete_allowed) {
    return config.is_loopback
      ? "Enabled — this server is bound to loopback."
      : "Enabled — TOUCH_MANAGER_ALLOW_REMOTE_DELETE=1 is set in the server environment.";
  }
  if (!config.is_loopback) {
    return (
      "Refused — this server is not bound to loopback. Set " +
      "TOUCH_MANAGER_ALLOW_REMOTE_DELETE=1 in the ComfyUI server environment and restart."
    );
  }
  return "Refused by the server.";
}

// ============================================================
// Forks — upstream + sibling repos a pack can be switched to
// ============================================================

/** One repository in GET /touch_manager/forks (upstream or fork sibling). */
export interface ForkRepo {
  full_name: string;
  owner: string;
  /** Clone/install URL — always an allowlisted https github.com URL. */
  url: string;
  description: string;
  stars: number;
  pushed_at: string | null;
  archived: boolean;
}

/** GET /touch_manager/forks?name=<pack>. */
export interface ForksResult {
  name: string;
  /** The pack's current origin URL (any forge), or null when it has no remote. */
  current: string | null;
  /** The repo this one was forked from, when it is itself a fork. */
  parent: ForkRepo | null;
  /** The root of the fork network, when it differs from `parent`. */
  source: ForkRepo | null;
  forks: ForkRepo[];
}

/** POST /touch_manager/remote — the applied fork switch. */
export interface RemoteSwitchResult {
  name: string;
  remote_before: string | null;
  remote_after: string;
  ref: string;
  before_short: string | null;
  after_short: string | null;
  changed_files: number;
  deps_changed: boolean;
  deps: DepsResult;
}

/** How a fork-picker row relates to the pack: where it is now, or where it came from. */
type ForkRole = "current" | "upstream" | "fork";

/** One fork-picker row: a repo plus its role relative to the installed pack. */
export interface ForkEntry {
  repo: ForkRepo;
  role: ForkRole;
}

/**
 * Reduce a repository URL to a comparable `host/owner/repo`: lowercased, with
 * any scheme, `git@host:` SSH form, trailing `.git`, and trailing slashes
 * removed. Used to tell whether two spellings name the SAME repository —
 * `git@github.com:Owner/Repo.git` and `https://github.com/owner/repo` do.
 */
export function normalizeRepoUrl(raw: string | null | undefined): string {
  const trimmed = (raw ?? "").trim().toLowerCase();
  if (!trimmed) return "";
  const ssh = /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+)$/.exec(trimmed);
  const candidate = ssh ? `https://${ssh[1]}/${ssh[2]}` : trimmed;
  const strip = (s: string): string => s.replace(/\.git$/, "").replace(/\/+$/, "");
  try {
    const u = new URL(candidate);
    return `${u.hostname}${strip(u.pathname)}`;
  } catch {
    return strip(candidate);
  }
}

/** True when two URLs name the same repository (see normalizeRepoUrl). */
export function sameRepo(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeRepoUrl(a);
  return na !== "" && na === normalizeRepoUrl(b);
}

/**
 * Browsable https URL for a repository, or `""` when this pack will not build
 * one. The gate is `ALLOWED_INSTALL_HOSTS` — the same allowlist the install
 * path uses — because every URL here arrives from the server or a third-party
 * API, and turning an arbitrary supplied string into an outbound link is a
 * larger promise than rendering it as text. A `""` return is the caller's cue
 * to render today's plain text.
 *
 * Built on normalizeRepoUrl, so `git@github.com:Owner/Repo.git` resolves the
 * same as `https://github.com/owner/repo`. Note that normalization lowercases:
 * both hosts resolve owner/repo case-insensitively, but refs do NOT, which is
 * why the ref fragment below is taken from its own argument and never from
 * the normalized path.
 */
export function repoHref(raw: string | null | undefined): string {
  const norm = normalizeRepoUrl(raw);
  if (!norm) return "";
  const segments = norm.split("/");
  const host = segments[0] ?? "";
  const path = segments.slice(1);
  if (!ALLOWED_INSTALL_HOSTS.has(host)) return "";
  if (path.length < 2 || path.some((s) => s === "")) return "";
  return `https://${host}/${path.join("/")}`;
}

/**
 * GitLab nests repository sub-pages under `/-/`; GitHub does not. Anything
 * else never reaches here — repoHref has already refused it.
 */
function subPagePrefix(base: string): string {
  return base.startsWith("https://gitlab.com/") ? "/-/" : "/";
}

/** Encode a ref for a URL path, preserving the `/` in `feat/thing`. */
function encodeRefPath(ref: string): string {
  return ref.split("/").map(encodeURIComponent).join("/");
}

/** Browse-a-branch/tag URL, or `""` when the repo or ref cannot be linked. */
export function treeHref(raw: string | null | undefined, ref: string | null | undefined): string {
  const base = repoHref(raw);
  const name = (ref ?? "").trim();
  if (!base || !name) return "";
  return `${base}${subPagePrefix(base)}tree/${encodeRefPath(name)}`;
}

/**
 * Single-commit URL, or `""` when the repo or sha cannot be linked. Takes the
 * FULL sha: a 7-char display abbreviation resolves on both hosts today, but
 * the caller already holds the full value and passing the truncated one throws
 * that away for nothing.
 */
export function commitHref(raw: string | null | undefined, sha: string | null | undefined): string {
  const base = repoHref(raw);
  const value = (sha ?? "").trim();
  if (!base || !/^[0-9a-f]{7,40}$/i.test(value)) return "";
  return `${base}${subPagePrefix(base)}commit/${value}`;
}

/** Short `owner/repo` label for a repository URL (falls back to the raw URL). */
export function repoLabel(url: string | null | undefined): string {
  const norm = normalizeRepoUrl(url);
  if (!norm) return "";
  const segments = norm.split("/");
  return segments.length >= 3 ? segments.slice(1).join("/") : norm;
}

/**
 * Order the fork picker: upstream repos first (the usual intent is "go back to
 * where this was forked from"), then every fork by star count, descending.
 * Duplicates are collapsed by repository identity — a repo that is both the
 * source and a listed fork appears once — and whichever entry matches the
 * pack's current remote is tagged `current` so the UI can mark it and refuse to
 * "switch" to where it already is.
 */
export function buildForkEntries(data: ForksResult): ForkEntry[] {
  const upstream = [data.source, data.parent].filter((r): r is ForkRepo => !!r);
  const forks = [...data.forks].sort(
    (a, b) => b.stars - a.stars || a.full_name.localeCompare(b.full_name),
  );
  const seen = new Set<string>();
  const out: ForkEntry[] = [];
  for (const [repo, role] of [
    ...upstream.map((r) => [r, "upstream"] as const),
    ...forks.map((r) => [r, "fork"] as const),
  ]) {
    const key = normalizeRepoUrl(repo.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ repo, role: sameRepo(repo.url, data.current) ? "current" : role });
  }
  return out;
}

/** One-line meta for a fork row: owner · stars · last push · archived. */
export function formatForkMeta(repo: ForkRepo): string {
  const parts: string[] = [repo.owner, `★ ${formatDownloads(repo.stars)}`];
  if (repo.pushed_at) parts.push(`pushed ${repo.pushed_at.slice(0, 10)}`);
  if (repo.archived) parts.push("archived");
  return parts.join(" · ");
}

/** One-line summary of an applied fork switch, for the success toast. */
export function formatRemoteSwitchSummary(r: RemoteSwitchResult): string {
  const parts: string[] = [];
  const before = repoLabel(r.remote_before);
  const after = repoLabel(r.remote_after);
  parts.push(before && before !== after ? `${before} → ${after}` : after);
  if (r.ref) parts.push(r.ref);
  if (r.before_short && r.after_short && r.before_short !== r.after_short) {
    parts.push(`${r.before_short} → ${r.after_short}`);
  }
  if (r.changed_files > 0) {
    parts.push(`${r.changed_files} file${r.changed_files === 1 ? "" : "s"} changed`);
  }
  return parts.join(" · ");
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
// Reconnect-after-restart polling
// ============================================================

/**
 * Timing for the post-restart reconnect poll (see watchForReconnect in the UI).
 * `graceMs` gives the process a beat to be replaced by os.execv before the first
 * probe (so we never see the OUTGOING server answer). `timeoutMs` is generous —
 * a heavy ComfyUI can take 30s+ to re-import every custom node before its HTTP
 * surface (and thus our /config route) answers again.
 */
export const RECONNECT_POLL = {
  graceMs: 1500,
  intervalMs: 2000,
  timeoutMs: 120000,
  countdownSeconds: 3,
} as const;

/** True once the reconnect poll has run past its timeout budget. */
export function reconnectExpired(
  elapsedMs: number,
  timeoutMs: number = RECONNECT_POLL.timeoutMs,
): boolean {
  return elapsedMs >= timeoutMs;
}

/** Status line for the "waiting for the server to come back" restart view. */
export function formatReconnectStatus(
  elapsedMs: number,
  timeoutMs: number = RECONNECT_POLL.timeoutMs,
): string {
  if (reconnectExpired(elapsedMs, timeoutMs)) {
    return "ComfyUI is taking longer than expected to come back — reload when it is ready.";
  }
  const secs = Math.max(0, Math.floor(elapsedMs / 1000));
  return `Waiting for ComfyUI to come back… (${secs}s)`;
}

// ============================================================
// Install-URL validation — mirror of the backend gate
// ============================================================

/**
 * Hosts the backend accepts for /install. Keep in lockstep with
 * touch_manager.py: github.com / gitlab.com only.
 */
export const ALLOWED_INSTALL_HOSTS: ReadonlySet<string> = new Set(["github.com", "gitlab.com"]);

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
    if (info.source === "registry") {
      return info.latest_version
        ? `update available — v${info.latest_version}`
        : "update available";
    }
    const parts: string[] = [];
    if (info.behind > 0) parts.push(`${info.behind} behind`);
    if (info.ahead > 0) parts.push(`${info.ahead} ahead`);
    return parts.length ? `update available — ${parts.join(", ")}` : "update available";
  }
  if (info.ahead > 0) return `${info.ahead} ahead (local commits)`;
  return "up to date";
}

/**
 * One-line summary of what an update applied. For a registry pack this is the
 * version transition; for a git pack it's the short SHA transition, commit
 * count, and changed-file count. Collapses to "already up to date" when the
 * pack was already at the target (no commits applied).
 */
export function formatUpdateSummary(r: UpdateResult): string {
  if (r.commits_applied === 0) return "Already up to date — nothing to apply.";
  if (r.source === "registry") {
    return r.before_version && r.after_version
      ? `${r.before_version} → ${r.after_version}`
      : "Updated.";
  }
  const parts: string[] = [];
  if (r.before_short && r.after_short) parts.push(`${r.before_short} → ${r.after_short}`);
  const commits = `${r.commits_applied} commit${r.commits_applied === 1 ? "" : "s"}`;
  parts.push(r.truncated ? `${commits} (log truncated)` : commits);
  if (r.changed_files > 0) {
    parts.push(`${r.changed_files} file${r.changed_files === 1 ? "" : "s"} changed`);
  }
  return parts.join(" · ");
}

/**
 * Human summary of a backend dependency-install attempt, or null when nothing
 * ran (no dependency file was touched). `level` picks the note styling: an
 * `info` note when pip succeeded, a `warn` note when it failed so the operator
 * knows to install manually before restarting.
 */
export function formatDepsResult(
  deps: DepsResult | null | undefined,
): { level: "info" | "warn"; text: string } | null {
  if (!deps?.attempted) return null;
  const sources = deps.sources.length ? deps.sources.join(", ") : "dependencies";
  if (deps.ok) {
    return { level: "info", text: `Installed Python dependencies (${sources}).` };
  }
  return {
    level: "warn",
    text: `Dependency install failed (${sources})${
      deps.error ? `: ${deps.error}` : ""
    } — install them manually before restarting.`,
  };
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
// Fuzzy-filter glue (over [name, remote_url, author])
// ============================================================

/** A pack plus the fuzzy match indices on its primary (name) field. */
export interface RankedPack<T> {
  pack: T;
  /** Indices into `pack.name` that matched, for highlighting. */
  primaryMatches: number[];
}

/**
 * Fuzzy-rank a pack list against a query over [name, remote_url, author,
 * description]. An empty query returns every pack (no matches), sorted by name
 * ascending. A non-empty query returns only matching packs, best score first,
 * carrying the primary-field (name) match indices for highlighting. `author` is
 * a git remote owner or a registry PublisherId — matching it lets "by <author>"
 * find every pack from that author regardless of repo/pack name. `description`
 * is the last field for the same reason it is the least trusted for display:
 * it makes "upscale" find the packs that do upscaling even when nobody put the
 * word in a repo name, but it must never outrank a name match.
 */
export function filterPacks<
  T extends {
    name: string;
    remote_url?: string | null;
    author?: string | null;
    description?: string | null;
  },
>(query: string, packs: readonly T[]): RankedPack<T>[] {
  const q = query.trim();
  if (!q) {
    return [...packs]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((pack) => ({ pack, primaryMatches: [] }));
  }
  const scored: Array<{ pack: T; score: number; primaryMatches: number[] }> = [];
  for (const pack of packs) {
    const r = fuzzyRank(q, [
      pack.name,
      pack.remote_url ?? null,
      pack.author || null,
      pack.description || null,
    ]);
    if (r) scored.push({ pack, score: r.score, primaryMatches: r.primaryMatches });
  }
  scored.sort((a, b) => b.score - a.score || a.pack.name.localeCompare(b.pack.name));
  return scored.map(({ pack, primaryMatches }) => ({ pack, primaryMatches }));
}

/**
 * Hoist packs with an available update to the top of an already-ordered list,
 * preserving the relative order within each group (stable partition). The order
 * a row already has — fuzzy score, then name — is kept inside the "has update"
 * and "no update" buckets, so the only movement is updatable packs floating up.
 * `hasUpdate` is called once per pack (typically a lookup into the sweep cache).
 */
export function hoistPacksWithUpdates<T extends { name: string }>(
  ranked: readonly RankedPack<T>[],
  hasUpdate: (name: string) => boolean,
): RankedPack<T>[] {
  const withUpdate: RankedPack<T>[] = [];
  const withoutUpdate: RankedPack<T>[] = [];
  for (const entry of ranked) {
    (hasUpdate(entry.pack.name) ? withUpdate : withoutUpdate).push(entry);
  }
  return [...withUpdate, ...withoutUpdate];
}
