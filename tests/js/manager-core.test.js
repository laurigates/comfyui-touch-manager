import { describe, expect, it } from "vitest";
// Pure-helper coverage for manager-core.ts. These are the functions that MUST
// stay in lockstep with the Python backend (URL gate, ref/version formatting)
// plus the fuzzy-filter glue. No DOM — runs in the node environment.
import {
  filterPacks,
  formatCommitLine,
  formatCoreBehind,
  formatDepsWarning,
  formatRef,
  formatUpdateStatus,
  formatUpdateSummary,
  installPermitted,
  rebootPermitted,
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

  it("surfaces a deps warning only when requirements.txt changed", () => {
    expect(formatDepsWarning(result({ deps_changed: false }))).toBeNull();
    expect(formatDepsWarning(result({ deps_changed: true }))).toMatch(/requirements\.txt/);
  });

  it("formats a commit line as '<short> <subject>'", () => {
    expect(formatCommitLine({ sha: "abc1234", subject: "fix: thing" })).toBe("abc1234 fix: thing");
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

describe("filterPacks — fuzzy ranking over [name, remote_url]", () => {
  const packs = [
    {
      name: "comfyui-touch-numeric",
      remote_url: "https://github.com/laurigates/comfyui-touch-numeric",
    },
    {
      name: "comfyui-sampler-info",
      remote_url: "https://github.com/laurigates/comfyui-sampler-info",
    },
    { name: "some-random-pack", remote_url: null },
  ];

  it("returns every pack sorted by name for an empty query", () => {
    const out = filterPacks("", packs);
    expect(out.map((r) => r.pack.name)).toEqual([
      "comfyui-sampler-info",
      "comfyui-touch-numeric",
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

  it("returns nothing when no field matches", () => {
    expect(filterPacks("zzzznomatch", packs)).toEqual([]);
  });
});
