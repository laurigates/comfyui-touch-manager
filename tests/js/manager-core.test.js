import { describe, expect, it } from "vitest";
// Pure-helper coverage for manager-core.ts. These are the functions that MUST
// stay in lockstep with the Python backend (URL gate, ref/version formatting)
// plus the fuzzy-filter glue. No DOM — runs in the node environment.
import {
  buildForkEntries,
  deletePermitted,
  filterPacks,
  formatCoreBehind,
  formatDepsResult,
  formatDownloads,
  formatForkMeta,
  formatNodeSummary,
  formatProgress,
  formatReconnectStatus,
  formatRef,
  formatRegistryMeta,
  formatRemoteSwitchSummary,
  formatUpdateStatus,
  formatUpdateSummary,
  hoistPacksWithUpdates,
  iconForKind,
  installPermitted,
  mergeVersionEntries,
  normalizeRegistryNode,
  normalizeRepoUrl,
  partitionUpdateResults,
  RECONNECT_POLL,
  rebootPermitted,
  reconnectExpired,
  repoLabel,
  sameRepo,
  sanitizePackName,
  sortBranches,
  sortTags,
  validateInstallUrl,
  versionOptions,
} from "../../src/manager-core.ts";

describe("installPermitted — mirror of the backend /install bind gate", () => {
  const cfg = (over) => ({
    allow_remote_install: false,
    is_loopback: false,
    manager_enabled: false,
    ...over,
  });

  it("permits install on a loopback bind even without the override", () => {
    // Regression: the common 127.0.0.1 setup must NOT disable install.
    expect(installPermitted(cfg({ is_loopback: true, allow_remote_install: false }))).toBe(true);
  });

  it("permits install on a non-loopback bind when the override is set", () => {
    expect(installPermitted(cfg({ is_loopback: false, allow_remote_install: true }))).toBe(true);
  });

  it("blocks install on a non-loopback bind without the override", () => {
    expect(installPermitted(cfg({ is_loopback: false, allow_remote_install: false }))).toBe(false);
  });

  it("defaults to permitted when config has not loaded yet (backend still gates)", () => {
    expect(installPermitted(null)).toBe(true);
  });
});

describe("rebootPermitted — mirror of the backend /reboot gate", () => {
  const cfg = (reboot_allowed) => ({
    allow_remote_install: false,
    is_loopback: true,
    manager_enabled: false,
    reboot_allowed,
  });

  it("shows the restart control when the backend reports it allowed", () => {
    expect(rebootPermitted(cfg(true))).toBe(true);
  });

  it("hides the restart control when the backend reports it disallowed", () => {
    expect(rebootPermitted(cfg(false))).toBe(false);
  });

  it("defaults to hidden when config has not loaded yet", () => {
    // Unlike install, reboot defaults to HIDDEN — never surface a button the
    // backend would reject.
    expect(rebootPermitted(null)).toBe(false);
  });
});

describe("validateInstallUrl — mirror of the backend URL gate", () => {
  it("accepts canonical github/gitlab https URLs and derives the dir name", () => {
    expect(validateInstallUrl("https://github.com/owner/my-pack")).toEqual({
      ok: true,
      name: "my-pack",
      host: "github.com",
      owner: "owner",
    });
    expect(validateInstallUrl("https://gitlab.com/group/proj")).toMatchObject({
      ok: true,
      name: "proj",
      host: "gitlab.com",
    });
  });

  it("strips a trailing .git from the derived name", () => {
    const v = validateInstallUrl("https://github.com/owner/Cool_Pack.git");
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.name).toBe("Cool_Pack");
  });

  it("rejects non-https schemes", () => {
    expect(validateInstallUrl("http://github.com/o/r")).toMatchObject({
      ok: false,
      reason: "not_https",
    });
    expect(validateInstallUrl("git@github.com:o/r.git")).toMatchObject({ ok: false });
  });

  it("rejects disallowed hosts", () => {
    expect(validateInstallUrl("https://evil.example.com/o/r")).toMatchObject({
      ok: false,
      reason: "host_not_allowed",
    });
    expect(validateInstallUrl("https://bitbucket.org/o/r")).toMatchObject({
      ok: false,
      reason: "host_not_allowed",
    });
  });

  it("rejects empty, unparseable, and owner-less URLs", () => {
    expect(validateInstallUrl("")).toMatchObject({ ok: false, reason: "empty" });
    expect(validateInstallUrl("   ")).toMatchObject({ ok: false, reason: "empty" });
    expect(validateInstallUrl("not a url")).toMatchObject({ ok: false });
    expect(validateInstallUrl("https://github.com/onlyowner")).toMatchObject({
      ok: false,
      reason: "missing_owner_repo",
    });
  });
});

describe("sanitizePackName", () => {
  it("keeps the allowed alphabet and strips the rest", () => {
    expect(sanitizePackName("My.Pack-01_v2")).toBe("My.Pack-01_v2");
    expect(sanitizePackName("we ird name!")).toBe("weirdname");
  });

  it("rejects path separators, dot, and dotdot", () => {
    expect(sanitizePackName("a/b")).toBe("");
    expect(sanitizePackName("a\\b")).toBe("");
    expect(sanitizePackName(".")).toBe("");
    expect(sanitizePackName("..")).toBe("");
    expect(sanitizePackName("")).toBe("");
  });
});

describe("formatRef / formatUpdateStatus / formatCoreBehind", () => {
  it("formats branch, tag, and detached refs", () => {
    expect(formatRef({ type: "branch", name: "main", sha: "abcdef1234567" })).toBe(
      "main @ abcdef1",
    );
    expect(formatRef({ type: "tag", name: "v1.2.0", sha: null })).toBe("v1.2.0");
    expect(formatRef({ type: "detached", name: null, sha: "deadbeefcafe" })).toBe(
      "detached @ deadbee",
    );
    expect(formatRef(null)).toBe("unknown");
  });

  it("formats update status across the cases", () => {
    expect(
      formatUpdateStatus({ name: "x", update_available: false, behind: 0, ahead: 0, error: null }),
    ).toBe("up to date");
    expect(
      formatUpdateStatus({ name: "x", update_available: true, behind: 3, ahead: 0, error: null }),
    ).toBe("update available — 3 behind");
    expect(
      formatUpdateStatus({ name: "x", update_available: true, behind: 3, ahead: 1, error: null }),
    ).toBe("update available — 3 behind, 1 ahead");
    expect(
      formatUpdateStatus({
        name: "x",
        update_available: false,
        behind: 0,
        ahead: 0,
        error: "boom",
      }),
    ).toBe("error: boom");
  });

  it("formats a registry pack's update status from its latest_version", () => {
    expect(
      formatUpdateStatus({
        name: "x",
        source: "registry",
        update_available: true,
        behind: 1,
        ahead: 0,
        error: null,
        latest_version: "1.2.0",
      }),
    ).toBe("update available — v1.2.0");
    expect(
      formatUpdateStatus({
        name: "x",
        source: "registry",
        update_available: false,
        behind: 0,
        ahead: 0,
        error: null,
        latest_version: null,
      }),
    ).toBe("up to date");
  });

  it("formats core behind counts", () => {
    expect(formatCoreBehind({ origin: 0, upstream: 0 })).toBe("up to date");
    expect(formatCoreBehind({ origin: 2, upstream: null })).toBe("2 behind origin");
    expect(formatCoreBehind({ origin: 2, upstream: 5 })).toBe("2 behind origin, 5 behind upstream");
  });
});

describe("update-result formatting", () => {
  const result = (over) => ({
    name: "pack",
    before_short: "abc1234",
    after_short: "def5678",
    commits_applied: 3,
    commit_log: [],
    changed_files: 5,
    deps_changed: false,
    deps: { attempted: false, ok: null, sources: [], error: null, log: "" },
    truncated: false,
    ...over,
  });

  it("summarises SHA transition, commit count, and file count", () => {
    expect(formatUpdateSummary(result())).toBe("abc1234 → def5678 · 3 commits · 5 files changed");
  });

  it("singularises one commit / one file", () => {
    expect(formatUpdateSummary(result({ commits_applied: 1, changed_files: 1 }))).toBe(
      "abc1234 → def5678 · 1 commit · 1 file changed",
    );
  });

  it("notes a truncated log", () => {
    expect(formatUpdateSummary(result({ truncated: true }))).toContain("log truncated");
  });

  it("collapses to up-to-date when nothing was applied", () => {
    expect(formatUpdateSummary(result({ commits_applied: 0 }))).toBe(
      "Already up to date — nothing to apply.",
    );
  });

  it("summarises a registry pack's version transition instead of SHAs", () => {
    expect(
      formatUpdateSummary(
        result({
          source: "registry",
          before_short: null,
          after_short: null,
          before_version: "1.0.0",
          after_version: "1.2.0",
          changed_files: 0,
        }),
      ),
    ).toBe("1.0.0 → 1.2.0");
  });

  it("collapses a no-op registry update to up-to-date", () => {
    expect(
      formatUpdateSummary(
        result({
          source: "registry",
          commits_applied: 0,
          before_version: "1.2.0",
          after_version: "1.2.0",
        }),
      ),
    ).toBe("Already up to date — nothing to apply.");
  });

  it("returns null for a deps record that never ran pip", () => {
    expect(formatDepsResult(null)).toBeNull();
    expect(formatDepsResult(undefined)).toBeNull();
    expect(
      formatDepsResult({ attempted: false, ok: null, sources: [], error: null, log: "" }),
    ).toBeNull();
  });

  it("reports a successful install as an info note naming the sources", () => {
    const note = formatDepsResult({
      attempted: true,
      ok: true,
      sources: ["requirements.txt", "pyproject.toml"],
      error: null,
      log: "",
    });
    expect(note).toEqual({
      level: "info",
      text: "Installed Python dependencies (requirements.txt, pyproject.toml).",
    });
  });

  it("reports a failed install as a warn note carrying the error", () => {
    const note = formatDepsResult({
      attempted: true,
      ok: false,
      sources: ["requirements.txt"],
      error: "requirements.txt: pip exited 1",
      log: "…",
    });
    expect(note?.level).toBe("warn");
    expect(note?.text).toMatch(/pip exited 1/);
    expect(note?.text).toMatch(/install them manually/);
  });
});

describe("progressive update-check helpers", () => {
  it("formats the progress label", () => {
    expect(formatProgress(0, 12)).toBe("checked 0/12");
    expect(formatProgress(3, 12)).toBe("checked 3/12");
  });

  it("partitions results into actionable / errored / up-to-date", () => {
    const mk = (over) => ({
      name: "p",
      update_available: false,
      behind: 0,
      ahead: 0,
      error: null,
      incoming: [],
      ...over,
    });
    const { actionable, errored, upToDate } = partitionUpdateResults([
      mk({ name: "a", update_available: true, behind: 2 }),
      mk({ name: "b", error: "boom" }),
      mk({ name: "c" }),
      // An errored row is errored even if update_available somehow set.
      mk({ name: "d", update_available: true, error: "x" }),
    ]);
    expect(actionable.map((r) => r.name)).toEqual(["a"]);
    expect(errored.map((r) => r.name)).toEqual(["b", "d"]);
    expect(upToDate.map((r) => r.name)).toEqual(["c"]);
  });
});

describe("ref / version sorting", () => {
  it("sorts branches with main/master/develop first", () => {
    expect(sortBranches(["feature-z", "master", "alpha", "main"])).toEqual([
      "main",
      "master",
      "alpha",
      "feature-z",
    ]);
  });

  it("sorts tags newest-semver-first, non-semver after", () => {
    expect(sortTags(["v1.0.0", "v1.2.0", "v1.10.0", "nightly", "v0.9.0"])).toEqual([
      "v1.10.0",
      "v1.2.0",
      "v1.0.0",
      "v0.9.0",
      "nightly",
    ]);
  });

  it("builds a deduplicated version-picker order (branches then tags)", () => {
    const opts = versionOptions({ branches: ["main", "dev"], tags: ["v2.0.0", "v1.0.0", "main"] });
    expect(opts[0]).toBe("main");
    expect(opts).toContain("v2.0.0");
    // "main" appears once even though it is in both lists.
    expect(opts.filter((r) => r === "main")).toHaveLength(1);
    // v2.0.0 sorts before v1.0.0.
    expect(opts.indexOf("v2.0.0")).toBeLessThan(opts.indexOf("v1.0.0"));
  });
});

describe("Comfy Registry helpers", () => {
  it("formats download counts compactly", () => {
    expect(formatDownloads(0)).toBe("0");
    expect(formatDownloads(42)).toBe("42");
    expect(formatDownloads(1500)).toBe("1.5k");
    expect(formatDownloads(2_500_000)).toBe("2.5M");
    expect(formatDownloads(null)).toBe("0");
  });

  it("maps a version-entry kind to a source tag", () => {
    expect(iconForKind("git")).toBe("git");
    expect(iconForKind("registry")).toBe("registry");
  });

  it("normalizes a sparse registry node with defaults", () => {
    const n = normalizeRegistryNode({ id: "comfyui-foo" });
    expect(n).toEqual({
      id: "comfyui-foo",
      name: "comfyui-foo",
      description: "",
      author: "",
      downloads: 0,
      icon: "",
      repository: "",
      latest_version: null,
      publisher: null,
    });
  });

  it("builds a registry-row meta line", () => {
    expect(
      formatRegistryMeta({
        id: "x",
        name: "X",
        description: "",
        author: "octocat",
        downloads: 1500,
        icon: "",
        repository: "",
        latest_version: "1.2.0",
        publisher: "octocat",
      }),
    ).toBe("octocat · 1.5k downloads · v1.2.0");
  });

  it("merges git refs and registry versions into one tagged list", () => {
    const entries = mergeVersionEntries({ branches: ["main"], tags: ["v2.0.0"] }, [
      { version: "1.0.0", deprecated: false },
      { version: "0.9.0", deprecated: true },
    ]);
    // Git entries first (branches then tags), then registry versions.
    expect(entries.map((e) => [e.kind, e.label])).toEqual([
      ["git", "main"],
      ["git", "v2.0.0"],
      ["registry", "1.0.0"],
      ["registry", "0.9.0"],
    ]);
    expect(entries[0].ref).toBe("main");
    expect(entries[2].version).toBe("1.0.0");
    expect(entries[3].meta).toBe("deprecated");
  });

  it("handles a registry-only merge (no git info)", () => {
    const entries = mergeVersionEntries(null, [{ version: "1.0.0", deprecated: false }]);
    expect(entries).toEqual([
      { kind: "registry", label: "1.0.0", version: "1.0.0", meta: undefined },
    ]);
  });
});

describe("filterPacks — fuzzy ranking over [name, remote_url, author]", () => {
  const packs = [
    {
      name: "comfyui-touch-numeric",
      remote_url: "https://github.com/laurigates/comfyui-touch-numeric",
      author: "laurigates",
    },
    {
      name: "comfyui-sampler-info",
      remote_url: "https://github.com/laurigates/comfyui-sampler-info",
      author: "laurigates",
    },
    { name: "some-random-pack", remote_url: null, author: "" },
    { name: "regnode", remote_url: null, author: "octocat" },
  ];

  it("returns every pack sorted by name for an empty query", () => {
    const out = filterPacks("", packs);
    expect(out.map((r) => r.pack.name)).toEqual([
      "comfyui-sampler-info",
      "comfyui-touch-numeric",
      "regnode",
      "some-random-pack",
    ]);
    expect(out.every((r) => r.primaryMatches.length === 0)).toBe(true);
  });

  it("filters to matches and ranks the best name hit first", () => {
    const out = filterPacks("touch", packs);
    expect(out.map((r) => r.pack.name)).toEqual(["comfyui-touch-numeric"]);
    expect(out[0].primaryMatches.length).toBeGreaterThan(0);
  });

  it("matches against the remote_url field too", () => {
    const out = filterPacks("laurigates", packs);
    expect(out.map((r) => r.pack.name).sort()).toEqual([
      "comfyui-sampler-info",
      "comfyui-touch-numeric",
    ]);
  });

  it("matches against the author field (e.g. a registry pack with no remote_url)", () => {
    const out = filterPacks("octocat", packs);
    expect(out.map((r) => r.pack.name)).toEqual(["regnode"]);
  });

  it("returns nothing when no field matches", () => {
    expect(filterPacks("zzzznomatch", packs)).toEqual([]);
  });

  it("matches against the description, so a search finds packs by what they do", () => {
    const described = [
      {
        name: "aaa-opaque-name",
        remote_url: null,
        author: "",
        description: "Tiled upscaling for large images.",
      },
      { name: "bbb-other", remote_url: null, author: "", description: "Audio reactive nodes." },
    ];
    // Two-sided: the word appears in NO name, so a hit proves the description
    // field is searched, and the miss proves it is not matching everything.
    expect(filterPacks("upscaling", described).map((r) => r.pack.name)).toEqual([
      "aaa-opaque-name",
    ]);
    expect(filterPacks("zzzznomatch", described)).toEqual([]);
  });

  it("never lets a description hit outrank a name hit", () => {
    const described = [
      // "sampler" only in the description, and sorts first alphabetically —
      // so a naive implementation would put it above the real name match.
      { name: "aaa-first", remote_url: null, author: "", description: "Picks a sampler for you." },
      { name: "comfyui-sampler-info", remote_url: null, author: "", description: "" },
    ];
    expect(filterPacks("sampler", described).map((r) => r.pack.name)).toEqual([
      "comfyui-sampler-info",
      "aaa-first",
    ]);
  });
});

describe("formatNodeSummary — what a pack contributed to the running install", () => {
  it("renders the count with its categories", () => {
    expect(formatNodeSummary({ node_count: 197, node_categories: ["ImpactPack"] })).toBe(
      "197 nodes · ImpactPack",
    );
    expect(formatNodeSummary({ node_count: 250, node_categories: ["KJNodes", "image"] })).toBe(
      "250 nodes · KJNodes, image",
    );
  });

  it("singularises a one-node pack", () => {
    expect(formatNodeSummary({ node_count: 1, node_categories: [] })).toBe("1 node");
  });

  it("renders nothing when the count is unknown, rather than claiming zero", () => {
    // null is "the backend could not determine this" — a disabled pack, or a
    // ComfyUI without node provenance. Both must render blank, never "0 nodes".
    expect(formatNodeSummary({ node_count: null, node_categories: [] })).toBe("");
    expect(formatNodeSummary({ node_count: 0, node_categories: ["x"] })).toBe("");
  });

  it("drops blank category strings instead of emitting a dangling separator", () => {
    expect(formatNodeSummary({ node_count: 2, node_categories: ["", "  "] })).toBe("2 nodes");
  });
});

describe("hoistPacksWithUpdates — float updatable packs to the top", () => {
  const ranked = (names) => names.map((name) => ({ pack: { name }, primaryMatches: [] }));

  it("moves packs with an available update ahead of the rest", () => {
    const withUpdate = new Set(["b", "d"]);
    const out = hoistPacksWithUpdates(ranked(["a", "b", "c", "d"]), (n) => withUpdate.has(n));
    expect(out.map((r) => r.pack.name)).toEqual(["b", "d", "a", "c"]);
  });

  it("is a stable partition — order within each group is preserved", () => {
    const withUpdate = new Set(["c"]);
    const out = hoistPacksWithUpdates(ranked(["a", "b", "c", "d", "e"]), (n) => withUpdate.has(n));
    // "c" hoisted; a,b,d,e keep their relative order.
    expect(out.map((r) => r.pack.name)).toEqual(["c", "a", "b", "d", "e"]);
  });

  it("is a no-op when nothing has an update (order unchanged)", () => {
    const out = hoistPacksWithUpdates(ranked(["a", "b", "c"]), () => false);
    expect(out.map((r) => r.pack.name)).toEqual(["a", "b", "c"]);
  });

  it("carries primaryMatches through untouched", () => {
    const input = [
      { pack: { name: "x" }, primaryMatches: [0, 1] },
      { pack: { name: "y" }, primaryMatches: [2] },
    ];
    const out = hoistPacksWithUpdates(input, (n) => n === "y");
    expect(out[0]).toEqual({ pack: { name: "y" }, primaryMatches: [2] });
    expect(out[1]).toEqual({ pack: { name: "x" }, primaryMatches: [0, 1] });
  });
});

describe("reconnect-after-restart poll helpers", () => {
  it("exposes a sane poll config (grace < timeout, positive interval)", () => {
    expect(RECONNECT_POLL.graceMs).toBeGreaterThan(0);
    expect(RECONNECT_POLL.intervalMs).toBeGreaterThan(0);
    expect(RECONNECT_POLL.timeoutMs).toBeGreaterThan(RECONNECT_POLL.graceMs);
    expect(RECONNECT_POLL.countdownSeconds).toBeGreaterThan(0);
  });

  it("reconnectExpired is false until the timeout budget is reached", () => {
    expect(reconnectExpired(0, 10000)).toBe(false);
    expect(reconnectExpired(9999, 10000)).toBe(false);
    expect(reconnectExpired(10000, 10000)).toBe(true);
    expect(reconnectExpired(20000, 10000)).toBe(true);
  });

  it("formatReconnectStatus counts up in seconds while waiting", () => {
    expect(formatReconnectStatus(0, 10000)).toMatch(/Waiting for ComfyUI.*\(0s\)/);
    expect(formatReconnectStatus(4200, 10000)).toContain("(4s)");
  });

  it("formatReconnectStatus switches to a took-longer message past the timeout", () => {
    expect(formatReconnectStatus(10000, 10000)).toMatch(/longer than expected/);
  });
});

describe("deletePermitted — mirror of the backend /delete gate", () => {
  const cfg = (delete_allowed) => ({
    allow_remote_install: false,
    is_loopback: false,
    manager_enabled: false,
    reboot_allowed: false,
    delete_allowed,
  });

  it("offers delete when the backend reports the gate open", () => {
    expect(deletePermitted(cfg(true))).toBe(true);
  });

  it("hides delete when the backend reports it closed", () => {
    expect(deletePermitted(cfg(false))).toBe(false);
  });

  it("hides delete until config loads — never show an irreversible button on a guess", () => {
    expect(deletePermitted(null)).toBe(false);
  });
});

describe("normalizeRepoUrl / sameRepo / repoLabel", () => {
  it("collapses the spellings of one repository to a single identity", () => {
    const canonical = "github.com/laurigates/comfyui-touch-manager";
    for (const url of [
      "https://github.com/laurigates/comfyui-touch-manager",
      "https://github.com/laurigates/comfyui-touch-manager.git",
      "https://github.com/laurigates/comfyui-touch-manager/",
      "https://github.com/Laurigates/ComfyUI-Touch-Manager",
      "git@github.com:laurigates/comfyui-touch-manager.git",
      "ssh://git@github.com/laurigates/comfyui-touch-manager",
    ]) {
      expect(normalizeRepoUrl(url)).toBe(canonical);
    }
  });

  it("keeps different owners (and different hosts) distinct", () => {
    expect(sameRepo("https://github.com/a/pack", "https://github.com/b/pack")).toBe(false);
    expect(sameRepo("https://github.com/a/pack", "https://gitlab.com/a/pack")).toBe(false);
    expect(sameRepo("https://github.com/a/pack", "git@github.com:a/pack.git")).toBe(true);
  });

  it("treats a missing remote as matching nothing (not even another missing one)", () => {
    expect(sameRepo(null, null)).toBe(false);
    expect(sameRepo("", "https://github.com/a/pack")).toBe(false);
  });

  it("repoLabel shortens a URL to owner/repo", () => {
    expect(repoLabel("https://github.com/laurigates/comfyui-touch-manager.git")).toBe(
      "laurigates/comfyui-touch-manager",
    );
    expect(repoLabel(null)).toBe("");
  });
});

describe("buildForkEntries — fork-picker ordering", () => {
  const repo = (full_name, over = {}) => ({
    full_name,
    owner: full_name.split("/")[0],
    url: `https://github.com/${full_name}`,
    description: "",
    stars: 0,
    pushed_at: null,
    archived: false,
    ...over,
  });

  it("puts upstream first, then forks by stars descending", () => {
    const entries = buildForkEntries({
      name: "pack",
      current: "https://github.com/me/pack",
      parent: repo("upstream/pack"),
      source: null,
      forks: [repo("small/pack", { stars: 2 }), repo("big/pack", { stars: 99 })],
    });
    expect(entries.map((e) => e.repo.full_name)).toEqual([
      "upstream/pack",
      "big/pack",
      "small/pack",
    ]);
    expect(entries.map((e) => e.role)).toEqual(["upstream", "fork", "fork"]);
  });

  it("tags the pack's current remote so the UI can refuse a no-op switch", () => {
    const entries = buildForkEntries({
      name: "pack",
      current: "git@github.com:me/pack.git", // a different spelling of the same repo
      parent: repo("upstream/pack"),
      source: null,
      forks: [repo("me/pack"), repo("other/pack")],
    });
    const byName = Object.fromEntries(entries.map((e) => [e.repo.full_name, e.role]));
    expect(byName["me/pack"]).toBe("current");
    expect(byName["upstream/pack"]).toBe("upstream");
    expect(byName["other/pack"]).toBe("fork");
  });

  it("marks upstream as current when the pack already tracks it", () => {
    const entries = buildForkEntries({
      name: "pack",
      current: "https://github.com/upstream/pack",
      parent: repo("upstream/pack"),
      source: null,
      forks: [repo("upstream/pack")],
    });
    expect(entries).toHaveLength(1); // deduped: listed as both parent and fork
    expect(entries[0].role).toBe("current");
  });

  it("dedupes source vs parent and keeps the first (upstream) position", () => {
    const entries = buildForkEntries({
      name: "pack",
      current: "https://github.com/me/pack",
      parent: repo("mid/pack"),
      source: repo("root/pack"),
      forks: [repo("mid/pack"), repo("me/pack")],
    });
    expect(entries.map((e) => e.repo.full_name)).toEqual(["root/pack", "mid/pack", "me/pack"]);
    expect(entries.map((e) => e.role)).toEqual(["upstream", "upstream", "current"]);
  });

  it("returns [] when the backend found nothing (non-GitHub remote, API down)", () => {
    expect(
      buildForkEntries({ name: "p", current: null, parent: null, source: null, forks: [] }),
    ).toEqual([]);
  });
});

describe("formatForkMeta", () => {
  const repo = (over) => ({
    full_name: "owner/pack",
    owner: "owner",
    url: "https://github.com/owner/pack",
    description: "",
    stars: 0,
    pushed_at: null,
    archived: false,
    ...over,
  });

  it("shows owner, compact stars, and the push date (no clock noise)", () => {
    expect(formatForkMeta(repo({ stars: 1500, pushed_at: "2026-04-01T09:30:00Z" }))).toBe(
      "owner · ★ 1.5k · pushed 2026-04-01",
    );
  });

  it("flags an archived fork so a dead-end switch is visible up front", () => {
    expect(formatForkMeta(repo({ archived: true }))).toContain("archived");
  });
});

describe("formatRemoteSwitchSummary", () => {
  const result = (over) => ({
    name: "pack",
    remote_before: "https://github.com/upstream/pack",
    remote_after: "https://github.com/fork/pack",
    ref: "main",
    before_short: "abc1234",
    after_short: "def5678",
    changed_files: 3,
    deps_changed: false,
    deps: { attempted: false, ok: null, sources: [], error: null, log: "" },
    ...over,
  });

  it("summarises the repo move, ref, sha transition, and file count", () => {
    expect(formatRemoteSwitchSummary(result({}))).toBe(
      "upstream/pack → fork/pack · main · abc1234 → def5678 · 3 files changed",
    );
  });

  it("collapses to the target repo when the sha and remote did not move", () => {
    expect(
      formatRemoteSwitchSummary(
        result({
          remote_before: "https://github.com/fork/pack",
          after_short: "abc1234",
          changed_files: 0,
        }),
      ),
    ).toBe("fork/pack · main");
  });
});
