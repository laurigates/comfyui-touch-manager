// @vitest-environment jsdom
//
// Repository URLs, remotes, branch and SHA are links, and STAY links.
//
// The point of the walk below is that the NEXT inert identifier fails CI, not
// that today's four are pinned by name: each tab is rendered against fixture
// data whose values are unmistakable, then the rendered subtree is scanned for
// URL-shaped and sha-shaped text and every hit must sit inside an <a>.
//
// Two-sidedness is the whole design here. "No bare URLs on screen" is
// satisfied by a renderer that draws nothing at all, so every scan is paired
// with a positive count and the exact href value — and the refusal path (a
// host outside the install allowlist) is asserted in the SAME test as the
// acceptance path, so an href builder hard-wired to return "" fails.
import { beforeEach, describe, expect, it } from "vitest";
import { commitHref, formatRef, repoHref, treeHref } from "../../src/manager-core.ts";
import { openManager } from "../../src/touch-manager-ui.ts";
import { __reset, __responses } from "./__mocks__/app.js";

const flush = () => new Promise((r) => setTimeout(r, 0));
const settle = async (n = 6) => {
  for (let i = 0; i < n; i++) await flush();
};
const clickButton = (label) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent === label)?.click();

// An https/ssh repo URL anywhere inside a text node.
const URLISH = /(https?:\/\/\S+|git@\S+:\S+)/;
// A standalone commit sha — a whole text node, so a sha embedded in a joined
// meta line ("main @ abc1234 · by X") is deliberately out of scope.
const SHAISH = /^[0-9a-f]{7,40}$/i;

function textNodes(root) {
  const out = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n);
  return out;
}

/** Text nodes carrying an identifier that is NOT inside an anchor. */
function inertIdentifiers(root, shape) {
  return textNodes(root)
    .filter((n) => shape.test(n.nodeValue.trim()))
    .filter((n) => !n.parentElement?.closest("a"))
    .map((n) => n.nodeValue.trim());
}

const anchors = (root) => [...root.querySelectorAll("a")];
const hrefs = (root) => anchors(root).map((a) => a.getAttribute("href"));

const CORE = {
  ok: true,
  is_git: true,
  ref: {
    type: "branch",
    // A slash in the branch name: the tree href must keep it as a path
    // separator rather than percent-encoding it into one segment.
    name: "feat/link-refs",
    sha: "0123456789abcdef0123456789abcdef01234567",
  },
  behind: { origin: 0, upstream: null },
  dirty: false,
  // SSH spelling, mixed case: proves the href goes through normalizeRepoUrl
  // rather than being emitted verbatim.
  remotes: { origin: "git@github.com:comfyanonymous/ComfyUI.git", upstream: null },
};
const CORE_REPO = "https://github.com/comfyanonymous/comfyui";

describe("href builders", () => {
  it("builds a repo href for allowlisted hosts and refuses everything else", () => {
    // Positive and negative in one test: a builder hard-wired to "" passes the
    // refusal half alone, and one that links anything passes the accept half.
    expect(repoHref("https://github.com/laurigates/comfyui-touch-manager")).toBe(
      "https://github.com/laurigates/comfyui-touch-manager",
    );
    expect(repoHref("git@github.com:Laurigates/Comfyui-Touch-Manager.git")).toBe(
      "https://github.com/laurigates/comfyui-touch-manager",
    );
    expect(repoHref("https://gitlab.com/group/sub/proj")).toBe("https://gitlab.com/group/sub/proj");
    expect(repoHref("https://evil.example.com/laurigates/pack")).toBe("");
    expect(repoHref("https://github.com/onlyowner")).toBe("");
    expect(repoHref("")).toBe("");
    expect(repoHref(null)).toBe("");
  });

  it("keeps slashes in a branch path and uses GitLab's /-/ prefix", () => {
    expect(treeHref("https://github.com/o/r", "feat/x")).toBe("https://github.com/o/r/tree/feat/x");
    expect(treeHref("https://gitlab.com/o/r", "main")).toBe("https://gitlab.com/o/r/-/tree/main");
    // A ref with a character that genuinely needs escaping still gets it.
    expect(treeHref("https://github.com/o/r", "release 1")).toBe(
      "https://github.com/o/r/tree/release%201",
    );
    expect(treeHref("https://evil.example.com/o/r", "main")).toBe("");
    expect(treeHref("https://github.com/o/r", "")).toBe("");
  });

  it("links a commit by its FULL sha and refuses a non-sha", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(commitHref("https://github.com/o/r", sha)).toBe(`https://github.com/o/r/commit/${sha}`);
    expect(commitHref("https://gitlab.com/o/r", sha)).toBe(
      `https://gitlab.com/o/r/-/commit/${sha}`,
    );
    expect(commitHref("https://github.com/o/r", "not-a-sha")).toBe("");
    expect(commitHref("https://github.com/o/r", null)).toBe("");
  });
});

describe("rendered identifiers are links", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    __reset();
    __responses["/touch_manager/config"] = {
      ok: true,
      allow_remote_install: true,
      is_loopback: true,
      manager_enabled: false,
      reboot_allowed: true,
      delete_allowed: true,
    };
    __responses["/touch_manager/installed"] = { ok: true, packs: [] };
    __responses["/touch_manager/updates/list"] = { ok: true, packs: [] };
  });

  it("links the Installed row's remote, and leaves an off-allowlist remote as text", async () => {
    __responses["/touch_manager/installed"] = {
      ok: true,
      packs: [
        {
          name: "pack-linked",
          path: "/x/pack-linked",
          root: "/x",
          is_git: true,
          ref: { type: "branch", name: "main", sha: "abc1234" },
          remote_url: "https://github.com/laurigates/pack-linked",
          dirty: false,
          enabled: true,
        },
        {
          name: "pack-selfhosted",
          path: "/x/pack-selfhosted",
          root: "/x",
          is_git: true,
          ref: { type: "branch", name: "main", sha: "def5678" },
          remote_url: "https://git.example.com/someone/pack-selfhosted",
          dirty: false,
          enabled: true,
        },
      ],
    };
    openManager();
    await settle();

    const linked = [...document.querySelectorAll(".tm-row")].find((r) =>
      r.textContent.includes("pack-linked"),
    );
    const selfhosted = [...document.querySelectorAll(".tm-row")].find((r) =>
      r.textContent.includes("pack-selfhosted"),
    );
    expect(linked).toBeTruthy();
    expect(selfhosted).toBeTruthy();

    // Accepted host → an anchor with the exact href, opened out-of-tab.
    expect(hrefs(linked)).toEqual(["https://github.com/laurigates/pack-linked"]);
    const a = anchors(linked)[0];
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    expect(a.textContent).toBe("https://github.com/laurigates/pack-linked");

    // Refused host → rendered exactly as before, as inert text. This is the
    // half that fails if the builder ever starts linking arbitrary hosts.
    expect(anchors(selfhosted)).toHaveLength(0);
    expect(selfhosted.textContent).toContain("https://git.example.com/someone/pack-selfhosted");
  });

  it("links the fork picker's repo titles with no bare URL left in the subtree", async () => {
    const forkRepo = (full_name) => ({
      full_name,
      owner: full_name.split("/")[0],
      url: `https://github.com/${full_name}`,
      description: "",
      stars: 12,
      pushed_at: "2026-06-01T00:00:00Z",
      archived: false,
    });
    __responses["/touch_manager/installed"] = {
      ok: true,
      packs: [
        {
          name: "comfyui-touch-resize",
          path: "/x/comfyui-touch-resize",
          root: "/x",
          is_git: true,
          ref: { type: "branch", name: "main", sha: "abc1234" },
          remote_url: "https://github.com/laurigates/comfyui-touch-resize",
          dirty: false,
          enabled: true,
        },
      ],
    };
    __responses["/touch_manager/forks"] = {
      ok: true,
      name: "comfyui-touch-resize",
      current: "https://github.com/laurigates/comfyui-touch-resize",
      parent: forkRepo("upstream-org/comfyui-touch-resize"),
      source: null,
      forks: [forkRepo("someone/comfyui-touch-resize")],
    };
    openManager();
    await settle();
    clickButton("Forks");
    await settle();

    const list = document.querySelector(".tm-list");
    expect(list).toBeTruthy();
    const linkHrefs = hrefs(list);
    // Positive half — without it the "no inert URLs" assertion below is
    // satisfied by a fork list that rendered nothing.
    expect(linkHrefs).toContain("https://github.com/upstream-org/comfyui-touch-resize");
    expect(linkHrefs).toContain("https://github.com/someone/comfyui-touch-resize");
    // Discovery half — any URL the pack starts rendering here without a link
    // fails from now on, named rather than counted.
    expect(inertIdentifiers(list, URLISH)).toEqual([]);
  });

  it("links the registry version picker's repository row", async () => {
    __responses["/touch_manager/registry/search"] = {
      ok: true,
      page: 1,
      total_pages: 1,
      nodes: [
        {
          id: "comfyui-foo",
          name: "Foo Node",
          description: "does foo things",
          author: "octocat",
          downloads: 1500,
          icon: "",
          repository: "https://github.com/octocat/comfyui-foo",
          latest_version: "1.2.0",
          publisher: "octocat",
        },
      ],
    };
    __responses["/touch_manager/registry/versions"] = {
      ok: true,
      id: "comfyui-foo",
      versions: [{ version: "1.2.0", deprecated: false }],
    };
    openManager();
    await settle();
    clickButton("Registry");
    await settle();
    clickButton("Search");
    await settle();
    clickButton("Versions");
    await settle();

    const body = document.querySelector(".cmp-body") ?? document.body;
    expect(body.textContent).toContain("1.2.0");
    expect(hrefs(body)).toContain("https://github.com/octocat/comfyui-foo");
    expect(inertIdentifiers(body, URLISH)).toEqual([]);
  });

  it("links the Core tab's branch, sha and remotes without changing the text", async () => {
    __responses["/touch_manager/core"] = CORE;
    openManager();
    await settle();
    clickButton("Core");
    await settle();

    const row = document.querySelector(".tm-row");
    expect(row).toBeTruthy();

    // The three distinct targets the issue names, all present at once.
    expect(hrefs(row)).toEqual([
      `${CORE_REPO}/tree/feat/link-refs`,
      `${CORE_REPO}/commit/0123456789abcdef0123456789abcdef01234567`,
      CORE_REPO,
    ]);

    // The commit link must carry the FULL sha. The displayed text is the
    // 7-char abbreviation, so an href rebuilt by parsing formatRef's output
    // could only ever have contained the truncated form.
    const commit = anchors(row).find((a) => a.getAttribute("href").includes("/commit/"));
    expect(commit.textContent).toBe("0123456");
    expect(commit.getAttribute("href")).toMatch(/\/commit\/[0-9a-f]{40}$/);

    // Nothing identifier-shaped escaped a link.
    expect(inertIdentifiers(row, URLISH)).toEqual([]);
    expect(inertIdentifiers(row, SHAISH)).toEqual([]);

    // Linking must not have rewritten the label: the rendered characters are
    // still exactly what the plain-text path produces. Asserted against
    // formatRef itself, so the two cannot drift apart independently.
    const refLine = [...row.children].find((c) => c.textContent.startsWith("Ref: "));
    expect(refLine.textContent).toBe(`Ref: ${formatRef(CORE.ref)}`);
  });

  it("leaves the Core ref inert when the checkout has no linkable remote", async () => {
    // The negative arm of the test above, differing ONLY in the remote host —
    // same ref, same sha. Without this, an implementation that links anything
    // it is handed passes every assertion above.
    __responses["/touch_manager/core"] = {
      ...CORE,
      remotes: { origin: "https://git.example.com/comfy/core", upstream: null },
    };
    openManager();
    await settle();
    clickButton("Core");
    await settle();

    const row = document.querySelector(".tm-row");
    expect(anchors(row)).toHaveLength(0);
    // Same text as the linked arm — only the anchors are gone.
    const refLine = [...row.children].find((c) => c.textContent.startsWith("Ref: "));
    expect(refLine.textContent).toBe(`Ref: ${formatRef(CORE.ref)}`);
    expect(row.textContent).toContain("https://git.example.com/comfy/core");
  });
});
