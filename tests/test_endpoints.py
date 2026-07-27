"""Tests for the /touch_manager/* endpoints and their pure helpers.

ComfyUI internals (folder_paths, comfy.cli_args, server) and aiohttp.web are
stubbed in conftest.py; each test sets the attributes it needs on the stubs.
Endpoint handlers are awaited directly with a fake aiohttp request.

Git-backed routes are exercised against REAL local git repos built with
subprocess in tmp_path — no network. A local path serves as the "remote", so
fetch / ls-remote / clone-advance all run offline.
"""

from __future__ import annotations

import asyncio
import io
import os
import subprocess
import zipfile

import comfy.cli_args
import folder_paths
import pytest
from aiohttp.web import Request

import touch_manager as pack

# ---------------------------------------------------------------------------
# git fixtures (real repos, local-path remotes, no network)
# ---------------------------------------------------------------------------

_GIT_CFG = [
    "-c",
    "user.email=t@example.com",
    "-c",
    "user.name=Test",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "init.defaultBranch=main",
]


def _git(cwd, *args, check=True):
    return subprocess.run(
        ["git", *_GIT_CFG, *args],
        cwd=str(cwd),
        check=check,
        capture_output=True,
        text=True,
    )


def _init_bare(path, branch="main"):
    path.mkdir(parents=True, exist_ok=True)
    _git(path, "init", "--bare", "-b", branch)


def _init_seed(path, origin):
    path.mkdir(parents=True, exist_ok=True)
    _git(path, "init", "-b", "main")
    _git(path, "remote", "add", "origin", str(origin))
    (path / "README.md").write_text("c1\n")
    _git(path, "add", ".")
    _git(path, "commit", "-m", "c1")
    _git(path, "push", "-u", "origin", "main")


def _clone(origin, dest):
    dest.parent.mkdir(parents=True, exist_ok=True)
    _git(dest.parent, "clone", str(origin), dest.name)


def _advance(seed, fname="README.md", content="c2\n"):
    (seed / fname).write_text(content)
    _git(seed, "add", ".")
    _git(seed, "commit", "-m", "c2")
    _git(seed, "push", "origin", "main")


def _init_plain(path):
    """A standalone repo with a branch + a tag and NO remote configured."""
    path.mkdir(parents=True, exist_ok=True)
    _git(path, "init", "-b", "main")
    (path / "f.txt").write_text("x\n")
    _git(path, "add", ".")
    _git(path, "commit", "-m", "init")
    _git(path, "branch", "feature")
    _git(path, "tag", "v1.0.0")


def _set_roots(*roots):
    folder_paths.get_folder_paths = lambda category: [str(r) for r in roots]


# ---------------------------------------------------------------------------
# request drivers
# ---------------------------------------------------------------------------


def _get(handler, **query):
    return asyncio.run(handler(Request(query=query)))


def _post(handler, **body):
    return asyncio.run(handler(Request(json_body=body)))


# ===========================================================================
# Pure security / validation helpers
# ===========================================================================


@pytest.mark.parametrize(
    ("url", "name"),
    [
        ("https://github.com/owner/repo", "repo"),
        ("https://github.com/owner/repo.git", "repo"),
        ("https://github.com/owner/repo/", "repo"),
        ("https://gitlab.com/group/sub/proj.git", "proj"),
    ],
)
def test_validate_url_accepts_allowlisted_hosts(url, name):
    assert pack._validate_url(url) == (name, None)


@pytest.mark.parametrize(
    "url",
    [
        "",
        None,
        "http://github.com/owner/repo",  # not https
        "https://evil.com/owner/repo",  # host not allowlisted
        "https://github.com/owner",  # no repo segment
        "ftp://github.com/o/r",
        "git@github.com:owner/repo.git",  # ssh form rejected for install
    ],
)
def test_validate_url_rejects_bad_input(url):
    name, code = pack._validate_url(url)
    assert name is None
    assert code == "invalid_url"


@pytest.mark.parametrize(
    "url",
    [
        "https://github.com/owner/..",
        "https://github.com/owner/.",
    ],
)
def test_validate_url_rejects_traversal_tail(url):
    assert pack._validate_url(url) == (None, "invalid_url")


@pytest.mark.parametrize("raw", ["", ".", "..", "a/b", "a\\b", "bad name!", "x;y"])
def test_sanitize_name_rejects_unsafe(raw):
    assert pack._sanitize_name(raw) is None


@pytest.mark.parametrize("raw", ["repo", "my-pack_1.0", "ComfyUI-Foo"])
def test_sanitize_name_accepts_safe(raw):
    assert pack._sanitize_name(raw) == raw


@pytest.mark.parametrize("ref", ["main", "v1.2.3", "feature/foo", "release-1.0"])
def test_safe_ref_accepts_normal_refs(ref):
    assert pack._safe_ref(ref) == ref


@pytest.mark.parametrize(
    "ref",
    [
        "",
        None,
        123,
        ["main"],
        "-f",  # git option, not a ref
        "--orphan",  # git option
        "--upload-pack=touch /tmp/pwned",  # argument-injection attempt
        "-b",
    ],
)
def test_safe_ref_rejects_option_injection(ref):
    assert pack._safe_ref(ref) is None


@pytest.mark.parametrize(
    ("listen", "expected"),
    [
        ("", True),
        ("127.0.0.1", True),
        ("localhost", True),
        ("::1", True),
        ("0.0.0.0", False),
        ("192.168.1.10", False),
    ],
)
def test_is_loopback(listen, expected):
    assert pack._is_loopback(listen) is expected


def test_within_root_guards_traversal(tmp_path):
    root = tmp_path / "custom_nodes"
    root.mkdir()
    assert pack._within_root(str(root / "pack"), str(root)) is True
    assert pack._within_root(str(root / ".." / "escape"), str(root)) is False


def test_remote_install_allowed_reads_env(monkeypatch):
    monkeypatch.delenv("TOUCH_MANAGER_ALLOW_REMOTE_INSTALL", raising=False)
    assert pack._remote_install_allowed() is False
    monkeypatch.setenv("TOUCH_MANAGER_ALLOW_REMOTE_INSTALL", "1")
    assert pack._remote_install_allowed() is True


def test_github_owner_repo_parses_forms():
    assert pack._github_owner_repo("https://github.com/o/r") == ("o", "r")
    assert pack._github_owner_repo("https://github.com/o/r.git") == ("o", "r")
    assert pack._github_owner_repo("git@github.com:o/r.git") == ("o", "r")
    assert pack._github_owner_repo("https://gitlab.com/o/r") is None
    assert pack._github_owner_repo(None) is None


def test_github_releases_empty_for_non_github():
    assert pack._github_releases("https://gitlab.com/o/r") == []
    assert pack._github_releases(None) == []


# ===========================================================================
# GET /touch_manager/config
# ===========================================================================


def test_config_loopback_default(monkeypatch):
    monkeypatch.setattr(comfy.cli_args.args, "listen", "")
    monkeypatch.delenv("TOUCH_MANAGER_ALLOW_REMOTE_INSTALL", raising=False)
    monkeypatch.delenv("TOUCH_MANAGER_ALLOW_REMOTE_REBOOT", raising=False)
    monkeypatch.delenv("TOUCH_MANAGER_ALLOW_REMOTE_DELETE", raising=False)
    resp = _get(pack.config)
    assert resp.status == 200
    body = resp.json_body
    assert body["ok"] is True
    assert body["is_loopback"] is True
    assert body["allow_remote_install"] is False
    assert body["manager_enabled"] is True
    # Reboot and delete are both allowed on a loopback bind by default.
    assert body["reboot_allowed"] is True
    assert body["delete_allowed"] is True


def test_config_non_loopback_with_override(monkeypatch):
    monkeypatch.setattr(comfy.cli_args.args, "listen", "0.0.0.0")
    monkeypatch.setenv("TOUCH_MANAGER_ALLOW_REMOTE_INSTALL", "1")
    monkeypatch.delenv("TOUCH_MANAGER_ALLOW_REMOTE_REBOOT", raising=False)
    monkeypatch.delenv("TOUCH_MANAGER_ALLOW_REMOTE_DELETE", raising=False)
    body = _get(pack.config).json_body
    assert body["is_loopback"] is False
    assert body["allow_remote_install"] is True
    # Reboot and delete stay off on a non-loopback bind without their own
    # opt-ins — the install override does not carry over to either.
    assert body["reboot_allowed"] is False
    assert body["delete_allowed"] is False


# ===========================================================================
# GET /touch_manager/installed — multi-root enumeration + ref parsing
# ===========================================================================


def test_installed_enumerates_all_roots(tmp_path):
    root1 = tmp_path / "root1"
    root2 = tmp_path / "root2"
    root1.mkdir()
    root2.mkdir()

    # root1: a git pack (origin remote), a plain dir, a disabled dir, and
    # names that must be skipped (dot + dunder).
    origin = tmp_path / "origin.git"
    _init_bare(origin)
    seed = tmp_path / "seed"
    _init_seed(seed, origin)
    _clone(origin, root1 / "git-pack")
    (root1 / "plain-pack").mkdir()
    (root1 / "disabled-pack.disabled").mkdir()
    (root1 / ".hidden").mkdir()
    (root1 / "__pycache__").mkdir()
    (root1 / "a-file.txt").write_text("not a dir")

    # root2: a second standalone git pack.
    _init_plain(root2 / "other-pack")

    _set_roots(root1, root2)
    resp = _get(pack.installed)
    assert resp.status == 200
    assert resp.json_body["ok"] is True
    packs = {p["name"]: p for p in resp.json_body["packs"]}

    # Skipped entries are absent; the file is absent.
    assert ".hidden" not in packs
    assert "__pycache__" not in packs
    assert "a-file.txt" not in packs

    git_pack = packs["git-pack"]
    assert git_pack["is_git"] is True
    assert git_pack["enabled"] is True
    assert git_pack["root"] == str(root1)
    assert git_pack["ref"]["type"] == "branch"
    assert git_pack["ref"]["name"] == "main"
    assert git_pack["ref"]["sha"]
    assert git_pack["remote_url"] == str(origin)
    assert git_pack["dirty"] is False

    plain = packs["plain-pack"]
    assert plain["is_git"] is False
    assert plain["remote_url"] is None
    assert plain["ref"] == {"type": "detached", "name": None, "sha": None}

    disabled = packs["disabled-pack"]  # name has the .disabled suffix stripped
    assert disabled["enabled"] is False

    assert packs["other-pack"]["root"] == str(root2)
    assert packs["other-pack"]["is_git"] is True


def test_installed_reports_dirty(tmp_path):
    root = tmp_path / "cn"
    root.mkdir()
    _init_plain(root / "dirtypack")
    (root / "dirtypack" / "f.txt").write_text("changed\n")  # uncommitted edit
    _set_roots(root)
    packs = {p["name"]: p for p in _get(pack.installed).json_body["packs"]}
    assert packs["dirtypack"]["dirty"] is True


def test_installed_empty_when_no_roots():
    folder_paths.get_folder_paths = lambda category: []
    resp = _get(pack.installed)
    assert resp.status == 200
    assert resp.json_body["packs"] == []


def test_parse_ref_branch_tag_detached(tmp_path):
    repo = tmp_path / "repo"
    _init_plain(repo)
    assert pack._parse_ref(str(repo))["type"] == "branch"

    _git(repo, "checkout", "v1.0.0")  # detached onto a tag
    ref = pack._parse_ref(str(repo))
    assert ref["type"] == "tag"
    assert ref["name"] == "v1.0.0"

    # Detached onto a raw commit (not a tag) -> detached, name None.
    sha = _git(repo, "rev-parse", "HEAD").stdout.strip()
    (repo / "f.txt").write_text("more\n")
    _git(repo, "commit", "-am", "c2")
    _git(repo, "tag", "-d", "v1.0.0")
    _git(repo, "checkout", sha)
    ref = pack._parse_ref(str(repo))
    assert ref["type"] == "detached"
    assert ref["name"] is None


# ===========================================================================
# GET /touch_manager/updates/list + /updates/check — progressive checking
# ===========================================================================


def test_updates_list_returns_git_packs_only(tmp_path):
    root = tmp_path / "cn"
    root.mkdir()
    origin = tmp_path / "origin.git"
    _init_bare(origin)
    seed = tmp_path / "seed"
    _init_seed(seed, origin)
    _clone(origin, root / "gitpack")
    (root / "plain").mkdir()  # not a git repo — must be skipped
    _clone(origin, root / "off.disabled")  # disabled git pack — must be skipped
    _set_roots(root)

    names = [p["name"] for p in _get(pack.updates_list).json_body["packs"]]
    # Disabled packs are excluded: updates/check (_find_pack without
    # include_disabled) cannot resolve them, so listing one is a phantom row.
    assert names == ["gitpack"]


def test_updates_check_reports_behind_with_incoming(tmp_path):
    root = tmp_path / "cn"
    root.mkdir()
    origin = tmp_path / "origin.git"
    _init_bare(origin)
    seed = tmp_path / "seed"
    _init_seed(seed, origin)
    _clone(origin, root / "pack")
    _advance(seed)  # one commit ahead on origin
    _set_roots(root)

    body = _get(pack.updates_check, name="pack").json_body
    assert body["ok"] is True
    assert body["update_available"] is True
    assert body["behind"] == 1
    assert body["error"] is None
    assert len(body["incoming"]) == 1
    assert body["incoming"][0]["subject"] == "c2"


def test_updates_check_up_to_date(tmp_path):
    root = tmp_path / "cn"
    root.mkdir()
    origin = tmp_path / "origin.git"
    _init_bare(origin)
    seed = tmp_path / "seed"
    _init_seed(seed, origin)
    _clone(origin, root / "pack")
    _set_roots(root)

    body = _get(pack.updates_check, name="pack").json_body
    assert body["update_available"] is False
    assert body["behind"] == 0
    assert body["incoming"] == []


def test_updates_check_invalid_name_is_400(tmp_path):
    _set_roots(tmp_path)
    resp = _get(pack.updates_check, name="../evil")
    assert resp.status == 400
    assert resp.json_body["code"] == "not_found"


def test_updates_check_not_git_is_400(tmp_path):
    root = tmp_path / "cn"
    root.mkdir()
    (root / "plain").mkdir()
    _set_roots(root)
    resp = _get(pack.updates_check, name="plain")
    assert resp.status == 400
    assert resp.json_body["code"] == "not_git"


def test_updates_check_fetch_failure_degrades(monkeypatch, tmp_path):
    root = tmp_path / "cn"
    root.mkdir()
    origin = tmp_path / "origin.git"
    _init_bare(origin)
    seed = tmp_path / "seed"
    _init_seed(seed, origin)
    _clone(origin, root / "pack")
    _set_roots(root)

    real_git = pack._git

    def flaky_git(args, cwd, timeout=60):
        if args[:1] == ["fetch"]:
            return 1, "", "network down"
        return real_git(args, cwd, timeout)

    monkeypatch.setattr(pack, "_git", flaky_git)
    resp = _get(pack.updates_check, name="pack")
    assert resp.status == 200  # per-pack degradation, not a hard failure
    assert resp.json_body["error"] == "network down"
    assert resp.json_body["update_available"] is False


# ===========================================================================
# GET /touch_manager/versions
# ===========================================================================


def test_versions_invalid_name_is_400():
    resp = _get(pack.versions, name="../etc")
    assert resp.status == 400
    assert resp.json_body["ok"] is False
    assert resp.json_body["code"] == "not_found"


def test_versions_not_found_is_404(tmp_path):
    root = tmp_path / "cn"
    root.mkdir()
    _set_roots(root)
    resp = _get(pack.versions, name="ghost")
    assert resp.status == 404
    assert resp.json_body["code"] == "not_found"


def test_versions_local_refs_when_no_remote(tmp_path):
    root = tmp_path / "cn"
    root.mkdir()
    _init_plain(root / "pack")  # no remote configured
    _set_roots(root)
    resp = _get(pack.versions, name="pack")
    assert resp.status == 200
    body = resp.json_body
    assert body["name"] == "pack"
    assert set(body["branches"]) == {"main", "feature"}
    assert body["tags"] == ["v1.0.0"]
    assert body["releases"] == []  # local path is not github


def test_versions_ls_remote_for_remote_pack(tmp_path):
    root = tmp_path / "cn"
    root.mkdir()
    origin = tmp_path / "origin.git"
    _init_bare(origin)
    seed = tmp_path / "seed"
    _init_seed(seed, origin)
    _git(seed, "branch", "feature")
    _git(seed, "push", "origin", "feature")
    _git(seed, "tag", "v2.0.0")
    _git(seed, "push", "origin", "v2.0.0")
    _clone(origin, root / "pack")

    _set_roots(root)
    body = _get(pack.versions, name="pack").json_body
    assert set(body["branches"]) == {"main", "feature"}
    assert body["tags"] == ["v2.0.0"]
    assert body["releases"] == []  # local-path origin -> non-github -> []


# ===========================================================================
# GET /touch_manager/forks — upstream + sibling discovery (GitHub API mocked)
# ===========================================================================


@pytest.mark.parametrize(
    "raw",
    [
        None,
        "not a dict",
        {"full_name": None},
        {"full_name": "no-slash"},
        {"full_name": "too/many/slashes"},
        {"full_name": "bad owner/pack"},  # would not survive the install URL gate
    ],
)
def test_normalize_github_repo_rejects_unusable(raw):
    # The picker must never offer a repo the /remote route would then refuse.
    assert pack._normalize_github_repo(raw) is None


def test_normalize_github_repo_keeps_the_fields_the_picker_renders():
    got = pack._normalize_github_repo(
        {
            "full_name": "octocat/pack",
            "owner": {"login": "octocat"},
            "description": "a pack",
            "stargazers_count": 42,
            "pushed_at": "2026-06-01T00:00:00Z",
            "archived": True,
        }
    )
    assert got == {
        "full_name": "octocat/pack",
        "owner": "octocat",
        "url": "https://github.com/octocat/pack",
        "description": "a pack",
        "stars": 42,
        "pushed_at": "2026-06-01T00:00:00Z",
        "archived": True,
    }


def test_forks_invalid_name_is_400():
    resp = _get(pack.forks, name="../escape")
    assert resp.status == 400
    assert resp.json_body["code"] == "not_found"


def test_forks_not_found_for_non_git_pack(tmp_path):
    root = tmp_path / "cn"
    root.mkdir()
    (root / "plain").mkdir()
    _set_roots(root)
    resp = _get(pack.forks, name="plain")
    assert resp.status == 404


def test_forks_empty_for_non_github_remote(tmp_path):
    # A pack whose origin is not github (here: a local path) still answers with
    # its current remote so the UI can offer the paste-a-URL fallback.
    origin = tmp_path / "origin.git"
    _init_bare(origin)
    _init_seed(tmp_path / "seed", origin)
    root = tmp_path / "cn"
    root.mkdir()
    _clone(origin, root / "pack")
    _set_roots(root)

    body = _get(pack.forks, name="pack").json_body
    assert body["ok"] is True
    assert body["current"] == str(origin)
    assert body["parent"] is None
    assert body["source"] is None
    assert body["forks"] == []


def _github_pack(monkeypatch, tmp_path, remote="https://github.com/me/pack"):
    """A git pack reporting a GitHub origin (nothing is ever fetched).

    The reported URL is stubbed rather than configured with ``git remote
    set-url``: ``git remote get-url`` applies any host-level ``url.<base>
    .insteadOf`` rewrite, so a developer (or CI sandbox) that proxies github.com
    would otherwise see a rewritten URL here and the test would test nothing.
    """
    origin = tmp_path / "origin.git"
    _init_bare(origin)
    _init_seed(tmp_path / "seed", origin)
    root = tmp_path / "cn"
    root.mkdir()
    _clone(origin, root / "pack")
    _set_roots(root)
    monkeypatch.setattr(pack, "_remote_url", lambda cwd, name="origin": remote)
    return root / "pack"


def test_forks_lists_upstream_and_siblings_from_the_root_repo(monkeypatch, tmp_path):
    _github_pack(monkeypatch, tmp_path)
    calls = []

    def fake_get(path, params=None):
        calls.append(path)
        if path == "/repos/me/pack":
            return {
                "full_name": "me/pack",
                "parent": {"full_name": "root-org/pack", "stargazers_count": 900},
                "source": {"full_name": "root-org/pack", "stargazers_count": 900},
            }
        if path == "/repos/root-org/pack/forks":
            return [
                {"full_name": "me/pack", "stargazers_count": 3},
                {"full_name": "other/pack", "stargazers_count": 11},
                {"full_name": "junk-entry"},  # unusable — dropped
            ]
        return None

    monkeypatch.setattr(pack, "_github_get", fake_get)
    body = _get(pack.forks, name="pack").json_body

    # Siblings come from the ROOT of the fork network, not from this fork
    # (whose own /forks would be empty).
    assert "/repos/root-org/pack/forks" in calls
    assert body["parent"]["full_name"] == "root-org/pack"
    assert body["source"] is None  # parent IS the source — not listed twice
    assert [f["full_name"] for f in body["forks"]] == ["me/pack", "other/pack"]


def test_forks_degrade_to_empty_when_the_github_api_is_unavailable(monkeypatch, tmp_path):
    _github_pack(monkeypatch, tmp_path)
    monkeypatch.setattr(pack, "_github_get", lambda path, params=None: None)
    body = _get(pack.forks, name="pack").json_body
    assert body["ok"] is True
    assert body["parent"] is None
    assert body["forks"] == []


def test_collect_forks_lists_own_forks_when_the_pack_is_not_a_fork(monkeypatch):
    calls = []

    def fake_get(path, params=None):
        calls.append(path)
        if path.endswith("/forks"):
            return [{"full_name": "downstream/pack"}]
        return {"full_name": "me/pack", "parent": None, "source": None}

    monkeypatch.setattr(pack, "_github_get", fake_get)
    got = pack._collect_forks("https://github.com/me/pack")
    assert "/repos/me/pack/forks" in calls
    assert [f["full_name"] for f in got["forks"]] == ["downstream/pack"]


# ===========================================================================
# POST /touch_manager/install — bind gate, validation, traversal, exists
# ===========================================================================


def test_install_blocked_on_non_loopback(monkeypatch, tmp_path):
    monkeypatch.setattr(comfy.cli_args.args, "listen", "0.0.0.0")
    monkeypatch.delenv("TOUCH_MANAGER_ALLOW_REMOTE_INSTALL", raising=False)
    root = tmp_path / "cn"
    root.mkdir()
    _set_roots(root)
    resp = _post(pack.install, url="https://github.com/owner/repo")
    assert resp.status == 403
    assert resp.json_body["code"] == "blocked_remote_bind"


def test_install_non_loopback_override_passes_gate(monkeypatch, tmp_path):
    # Override clears the bind gate; an empty URL then fails at validation,
    # which proves the gate was passed (not short-circuited).
    monkeypatch.setattr(comfy.cli_args.args, "listen", "0.0.0.0")
    monkeypatch.setenv("TOUCH_MANAGER_ALLOW_REMOTE_INSTALL", "1")
    root = tmp_path / "cn"
    root.mkdir()
    _set_roots(root)
    resp = _post(pack.install, url="not-a-url")
    assert resp.status == 400
    assert resp.json_body["code"] == "invalid_url"


def test_install_invalid_url_on_loopback(monkeypatch, tmp_path):
    monkeypatch.setattr(comfy.cli_args.args, "listen", "")
    root = tmp_path / "cn"
    root.mkdir()
    _set_roots(root)
    resp = _post(pack.install, url="https://evil.example/owner/repo")
    assert resp.status == 400
    assert resp.json_body["ok"] is False
    assert resp.json_body["code"] == "invalid_url"


def test_install_rejects_existing_target(monkeypatch, tmp_path):
    monkeypatch.setattr(comfy.cli_args.args, "listen", "")
    root = tmp_path / "cn"
    root.mkdir()
    (root / "repo").mkdir()  # target already present
    _set_roots(root)
    resp = _post(pack.install, url="https://github.com/owner/repo")
    assert resp.status == 409
    assert resp.json_body["code"] == "exists"


def test_install_clones_and_optionally_checks_out(monkeypatch, tmp_path):
    monkeypatch.setattr(comfy.cli_args.args, "listen", "")
    root = tmp_path / "cn"
    root.mkdir()
    _set_roots(root)

    calls = []

    def fake_git(args, cwd, timeout=60):
        calls.append(args)
        if args[0] == "clone":
            os.makedirs(args[2], exist_ok=True)
        return 0, "", ""

    monkeypatch.setattr(pack, "_git", fake_git)
    resp = _post(pack.install, url="https://github.com/owner/repo", ref="v1.2.3")
    assert resp.status == 200
    body = resp.json_body
    assert body["ok"] is True
    assert body["name"] == "repo"
    assert body["restart_required"] is True
    assert calls[0][0] == "clone"
    assert calls[1] == ["checkout", "v1.2.3"]


def test_install_reports_clone_failure(monkeypatch, tmp_path):
    monkeypatch.setattr(comfy.cli_args.args, "listen", "")
    root = tmp_path / "cn"
    root.mkdir()
    _set_roots(root)
    monkeypatch.setattr(pack, "_git", lambda args, cwd, timeout=60: (128, "", "boom"))
    resp = _post(pack.install, url="https://github.com/owner/repo")
    assert resp.status == 500
    assert resp.json_body["code"] == "clone_failed"
    assert resp.json_body["error"] == "boom"


def test_install_rejects_option_injection_ref_before_clone(monkeypatch, tmp_path):
    # A ref starting with '-' is an argument-injection attempt; it must be
    # rejected BEFORE git runs (no clone attempted at all).
    monkeypatch.setattr(comfy.cli_args.args, "listen", "")
    root = tmp_path / "cn"
    root.mkdir()
    _set_roots(root)
    called = []
    monkeypatch.setattr(pack, "_git", lambda *a, **k: called.append(a) or (0, "", ""))
    resp = _post(
        pack.install,
        url="https://github.com/owner/repo",
        ref="--upload-pack=touch /tmp/pwned",
    )
    assert resp.status == 400
    assert resp.json_body["code"] == "checkout_failed"
    assert called == []  # git never ran


# ===========================================================================
# POST /touch_manager/update
# ===========================================================================


def test_update_not_found(tmp_path):
    root = tmp_path / "cn"
    root.mkdir()
    _set_roots(root)
    resp = _post(pack.update, name="ghost")
    assert resp.status == 404
    assert resp.json_body["code"] == "not_found"


def test_update_not_git(tmp_path):
    root = tmp_path / "cn"
    root.mkdir()
    (root / "plain").mkdir()
    _set_roots(root)
    resp = _post(pack.update, name="plain")
    assert resp.status == 400
    assert resp.json_body["code"] == "not_git"


def test_update_fast_forwards_current_branch(tmp_path):
    root = tmp_path / "cn"
    root.mkdir()
    origin = tmp_path / "origin.git"
    _init_bare(origin)
    seed = tmp_path / "seed"
    _init_seed(seed, origin)
    _clone(origin, root / "pack")
    _advance(seed)
    _set_roots(root)

    before = _git(root / "pack", "rev-parse", "HEAD").stdout.strip()
    resp = _post(pack.update, name="pack")
    assert resp.status == 200
    assert resp.json_body["restart_required"] is True
    after = _git(root / "pack", "rev-parse", "HEAD").stdout.strip()
    assert after != before  # the pack moved forward to origin's tip


def test_update_checks_out_explicit_ref(tmp_path):
    root = tmp_path / "cn"
    root.mkdir()
    origin = tmp_path / "origin.git"
    _init_bare(origin)
    seed = tmp_path / "seed"
    _init_seed(seed, origin)
    _git(seed, "tag", "v9.9.9")
    _git(seed, "push", "origin", "v9.9.9")
    _clone(origin, root / "pack")
    _set_roots(root)

    resp = _post(pack.update, name="pack", ref="v9.9.9")
    assert resp.status == 200
    ref = pack._parse_ref(str(root / "pack"))
    assert ref["type"] == "tag"
    assert ref["name"] == "v9.9.9"


def test_update_returns_change_detail(tmp_path):
    root = tmp_path / "cn"
    root.mkdir()
    origin = tmp_path / "origin.git"
    _init_bare(origin)
    seed = tmp_path / "seed"
    _init_seed(seed, origin)
    _clone(origin, root / "pack")
    _advance(seed)  # one new commit on origin
    _set_roots(root)

    before = _git(root / "pack", "rev-parse", "HEAD").stdout.strip()
    body = _post(pack.update, name="pack").json_body
    after = _git(root / "pack", "rev-parse", "HEAD").stdout.strip()

    assert body["commits_applied"] == 1
    assert body["before_short"] == before[:7]
    assert body["after_short"] == after[:7]
    assert body["changed_files"] >= 1
    assert body["deps_changed"] is False
    assert body["truncated"] is False
    assert len(body["commit_log"]) == 1
    entry = body["commit_log"][0]
    assert entry["sha"] and entry["subject"] == "c2"


def test_update_reports_deps_changed(tmp_path):
    root = tmp_path / "cn"
    root.mkdir()
    origin = tmp_path / "origin.git"
    _init_bare(origin)
    seed = tmp_path / "seed"
    _init_seed(seed, origin)
    _clone(origin, root / "pack")
    _advance(seed, fname="requirements.txt", content="numpy\n")
    _set_roots(root)

    body = _post(pack.update, name="pack").json_body
    assert body["deps_changed"] is True


def test_update_commit_log_is_capped(tmp_path):
    root = tmp_path / "cn"
    root.mkdir()
    origin = tmp_path / "origin.git"
    _init_bare(origin)
    seed = tmp_path / "seed"
    _init_seed(seed, origin)
    _clone(origin, root / "pack")
    # Advance origin by more commits than the log cap.
    for i in range(pack._UPDATE_LOG_CAP + 5):
        _advance(seed, content=f"line {i}\n")
    _set_roots(root)

    body = _post(pack.update, name="pack").json_body
    assert body["commits_applied"] == pack._UPDATE_LOG_CAP + 5
    assert len(body["commit_log"]) == pack._UPDATE_LOG_CAP
    assert body["truncated"] is True


def test_update_no_op_reports_zero_commits(tmp_path):
    root = tmp_path / "cn"
    root.mkdir()
    origin = tmp_path / "origin.git"
    _init_bare(origin)
    seed = tmp_path / "seed"
    _init_seed(seed, origin)
    _clone(origin, root / "pack")  # already at origin's tip
    _set_roots(root)

    body = _post(pack.update, name="pack").json_body
    assert body["commits_applied"] == 0
    assert body["commit_log"] == []
    assert body["before_short"] == body["after_short"]


def test_update_rejects_option_injection_ref_before_fetch(monkeypatch, tmp_path):
    # An option-injection ref must be rejected before fetch/checkout run.
    root = tmp_path / "cn"
    root.mkdir()
    origin = tmp_path / "origin.git"
    _init_bare(origin)
    seed = tmp_path / "seed"
    _init_seed(seed, origin)
    _clone(origin, root / "pack")
    _set_roots(root)
    calls = []
    real_git = pack._git
    monkeypatch.setattr(pack, "_git", lambda *a, **k: calls.append(a[0]) or real_git(*a, **k))
    resp = _post(pack.update, name="pack", ref="-f")
    assert resp.status == 400
    assert resp.json_body["code"] == "checkout_failed"
    assert "fetch" not in calls and "checkout" not in calls  # neither ran


def test_update_dirty_tree_blocks_without_force(tmp_path):
    # A dirty tree whose local edit conflicts with the incoming update blocks a
    # non-forced fast-forward (the frontend then offers Cancel or Force).
    root = tmp_path / "cn"
    root.mkdir()
    origin = tmp_path / "origin.git"
    _init_bare(origin)
    seed = tmp_path / "seed"
    _init_seed(seed, origin)
    _clone(origin, root / "pack")
    _advance(seed)  # origin advances README to c2
    (root / "pack" / "README.md").write_text("uncommitted local edit\n")
    _set_roots(root)
    assert pack._is_dirty(str(root / "pack")) is True

    resp = _post(pack.update, name="pack")
    assert resp.status == 500
    assert resp.json_body["code"] == "checkout_failed"
    # Nothing was applied — the local edit is intact.
    assert (root / "pack" / "README.md").read_text() == "uncommitted local edit\n"


def test_update_force_discards_local_changes_and_fast_forwards(tmp_path):
    root = tmp_path / "cn"
    root.mkdir()
    origin = tmp_path / "origin.git"
    _init_bare(origin)
    seed = tmp_path / "seed"
    _init_seed(seed, origin)
    _clone(origin, root / "pack")
    _advance(seed)
    (root / "pack" / "README.md").write_text("uncommitted local edit\n")
    _set_roots(root)

    resp = _post(pack.update, name="pack", force=True)
    assert resp.status == 200
    assert resp.json_body["commits_applied"] == 1
    # The local edit was discarded; the pack now matches origin's tip.
    assert pack._is_dirty(str(root / "pack")) is False
    assert (root / "pack" / "README.md").read_text() == "c2\n"


def test_update_force_checks_out_ref_on_dirty_tree(tmp_path):
    root = tmp_path / "cn"
    root.mkdir()
    origin = tmp_path / "origin.git"
    _init_bare(origin)
    seed = tmp_path / "seed"
    _init_seed(seed, origin)
    _clone(origin, root / "pack")  # pack at c1 (README = "c1")
    # Tag a LATER commit so the target ref differs in README from the local tree.
    _advance(seed)  # origin README -> c2
    _git(seed, "tag", "v9.9.9")
    _git(seed, "push", "origin", "v9.9.9")
    (root / "pack" / "README.md").write_text("dirty\n")
    _set_roots(root)

    # A plain checkout is blocked by the conflicting local change; force (-f)
    # discards it and lands on the tag.
    assert _post(pack.update, name="pack", ref="v9.9.9").status == 500
    resp = _post(pack.update, name="pack", ref="v9.9.9", force=True)
    assert resp.status == 200
    ref = pack._parse_ref(str(root / "pack"))
    assert ref["type"] == "tag" and ref["name"] == "v9.9.9"
    assert pack._is_dirty(str(root / "pack")) is False


# ===========================================================================
# POST /touch_manager/remote — switch a pack to a different fork
# ===========================================================================


def _seed_fork(path, origin, *, branch="main", files=None):
    """Seed a second upstream ('a fork') with its own content on ``branch``."""
    path.mkdir(parents=True, exist_ok=True)
    _git(path, "init", "-b", branch)
    _git(path, "remote", "add", "origin", str(origin))
    for name, content in (files or {"FORK.md": "fork\n"}).items():
        (path / name).write_text(content)
    _git(path, "add", ".")
    _git(path, "commit", "-m", "fork c1")
    _git(path, "push", "-u", "origin", branch)
    return path


def _fork_setup(tmp_path, *, fork_branch="main", fork_files=None):
    """A pack cloned from origin A, plus an unrelated 'fork' B to switch to.

    Returns (pack_dir, origin_bare, fork_bare, fork_seed). Everything is local —
    the switch does a real fetch + checkout with no network.
    """
    origin = tmp_path / "origin.git"
    _init_bare(origin)
    _init_seed(tmp_path / "seed", origin)

    fork = tmp_path / "fork.git"
    _init_bare(fork, fork_branch)
    fork_seed = _seed_fork(tmp_path / "fork-seed", fork, branch=fork_branch, files=fork_files)

    root = tmp_path / "cn"
    root.mkdir()
    _clone(origin, root / "pack")
    _set_roots(root)
    return root / "pack", origin, fork, fork_seed


def test_do_remote_switch_repoints_origin_and_checks_out_its_default_branch(tmp_path):
    pack_dir, origin, fork, _ = _fork_setup(tmp_path)
    result, err, code = pack._do_remote_switch(str(pack_dir), str(fork), None)

    assert (err, code) == ("", "")
    assert result["ref"] == "main"
    assert result["remote_before"] == str(origin)
    assert result["remote_after"] == str(fork)
    assert result["before_short"] != result["after_short"]
    assert result["changed_files"] > 0
    # The working tree is the fork's, the directory name is untouched, and
    # origin now points at the fork.
    assert (pack_dir / "FORK.md").is_file()
    assert not (pack_dir / "README.md").exists()
    assert pack._remote_url(str(pack_dir)) == str(fork)
    assert pack_dir.name == "pack"


def test_do_remote_switch_follows_the_new_remotes_own_default_branch(tmp_path):
    # The fork's default is "trunk" while the pack was on "main" — the switch
    # must land on the NEW remote's default, not reuse the old branch name.
    pack_dir, _, fork, _ = _fork_setup(tmp_path, fork_branch="trunk")
    result, err, _ = pack._do_remote_switch(str(pack_dir), str(fork), None)
    assert err == ""
    assert result["ref"] == "trunk"
    ref = pack._parse_ref(str(pack_dir))
    assert (ref["type"], ref["name"]) == ("branch", "trunk")


def test_do_remote_switch_tracks_the_new_remote_so_later_updates_fast_forward(tmp_path):
    pack_dir, _, fork, fork_seed = _fork_setup(tmp_path)
    pack._do_remote_switch(str(pack_dir), str(fork), None)

    # A new commit on the fork now registers as "behind" for the ordinary
    # update check — i.e. the local branch really tracks origin/main.
    (fork_seed / "FORK.md").write_text("fork c2\n")
    _git(fork_seed, "add", ".")
    _git(fork_seed, "commit", "-m", "fork c2")
    _git(fork_seed, "push", "origin", "main")

    info = pack._check_one_update(str(pack_dir), "pack")
    assert info["update_available"] is True
    assert info["behind"] == 1


def test_do_remote_switch_checks_out_an_explicit_tag_detached(tmp_path):
    pack_dir, _, fork, fork_seed = _fork_setup(tmp_path)
    _git(fork_seed, "tag", "v9.9.9")
    _git(fork_seed, "push", "origin", "v9.9.9")

    result, err, _ = pack._do_remote_switch(str(pack_dir), str(fork), "v9.9.9")
    assert err == ""
    assert result["ref"] == "v9.9.9"
    assert pack._parse_ref(str(pack_dir))["type"] == "tag"


def test_do_remote_switch_restores_the_old_remote_when_the_fetch_fails(tmp_path):
    pack_dir, origin, _, _ = _fork_setup(tmp_path)
    result, err, code = pack._do_remote_switch(str(pack_dir), str(tmp_path / "nope.git"), None)

    assert result is None
    assert code == "fetch_failed"
    assert err
    # Nothing moved: the pack still points at (and contains) the original repo.
    assert pack._remote_url(str(pack_dir)) == str(origin)
    assert (pack_dir / "README.md").is_file()


def test_do_remote_switch_refuses_a_dirty_tree_then_succeeds_with_force(tmp_path):
    pack_dir, origin, fork, _ = _fork_setup(tmp_path)
    (pack_dir / "README.md").write_text("local edit\n")

    result, _, code = pack._do_remote_switch(str(pack_dir), str(fork), None)
    assert result is None
    assert code == "checkout_failed"
    # The failed switch left both the remote and the local edit alone.
    assert pack._remote_url(str(pack_dir)) == str(origin)
    assert (pack_dir / "README.md").read_text() == "local edit\n"

    result, err, _ = pack._do_remote_switch(str(pack_dir), str(fork), None, True)
    assert err == ""
    assert (pack_dir / "FORK.md").is_file()
    assert pack._remote_url(str(pack_dir)) == str(fork)


def test_do_remote_switch_keeps_untracked_files_when_forced(tmp_path):
    pack_dir, _, fork, _ = _fork_setup(tmp_path)
    (pack_dir / "README.md").write_text("local edit\n")
    (pack_dir / "my-notes.txt").write_text("mine\n")

    _, err, _ = pack._do_remote_switch(str(pack_dir), str(fork), None, True)
    assert err == ""
    assert (pack_dir / "my-notes.txt").read_text() == "mine\n"


def test_do_remote_switch_adds_an_origin_to_a_pack_that_has_none(tmp_path):
    root = tmp_path / "cn"
    root.mkdir()
    plain = root / "plain"
    _init_plain(plain)
    _set_roots(root)
    fork = tmp_path / "fork.git"
    _init_bare(fork)
    _seed_fork(tmp_path / "fork-seed", fork)

    result, err, _ = pack._do_remote_switch(str(plain), str(fork), None)
    assert err == ""
    assert result["remote_before"] is None
    assert pack._remote_url(str(plain)) == str(fork)


def test_do_remote_switch_flags_a_dependency_change(tmp_path):
    pack_dir, _, fork, _ = _fork_setup(
        tmp_path, fork_files={"FORK.md": "fork\n", "requirements.txt": "numpy\n"}
    )
    result, err, _ = pack._do_remote_switch(str(pack_dir), str(fork), None)
    assert err == ""
    assert result["deps_changed"] is True


def _loopback(monkeypatch):
    monkeypatch.setattr(comfy.cli_args.args, "listen", "")
    monkeypatch.delenv("TOUCH_MANAGER_ALLOW_REMOTE_INSTALL", raising=False)


def test_remote_switch_blocked_on_non_loopback(monkeypatch, tmp_path):
    monkeypatch.setattr(comfy.cli_args.args, "listen", "0.0.0.0")
    monkeypatch.delenv("TOUCH_MANAGER_ALLOW_REMOTE_INSTALL", raising=False)
    pack_dir, origin, _, _ = _fork_setup(tmp_path)
    resp = _post(pack.remote, name="pack", url="https://github.com/other/pack")
    assert resp.status == 403
    assert resp.json_body["code"] == "blocked_remote_bind"
    assert pack._remote_url(str(pack_dir)) == str(origin)  # untouched


def test_remote_switch_rejects_a_non_allowlisted_url(monkeypatch, tmp_path):
    _loopback(monkeypatch)
    pack_dir, origin, _, _ = _fork_setup(tmp_path)
    resp = _post(pack.remote, name="pack", url="https://evil.example.com/a/b")
    assert resp.status == 400
    assert resp.json_body["code"] == "invalid_url"
    assert pack._remote_url(str(pack_dir)) == str(origin)


def test_remote_switch_rejects_option_injection_ref_before_touching_git(monkeypatch, tmp_path):
    _loopback(monkeypatch)
    pack_dir, origin, _, _ = _fork_setup(tmp_path)
    resp = _post(
        pack.remote,
        name="pack",
        url="https://github.com/other/pack",
        ref="--upload-pack=touch /tmp/pwned",
    )
    assert resp.status == 400
    assert resp.json_body["code"] == "checkout_failed"
    assert pack._remote_url(str(pack_dir)) == str(origin)


def test_remote_switch_not_found_is_404(monkeypatch, tmp_path):
    _loopback(monkeypatch)
    root = tmp_path / "cn"
    root.mkdir()
    _set_roots(root)
    resp = _post(pack.remote, name="ghost", url="https://github.com/other/pack")
    assert resp.status == 404


def test_remote_switch_not_git_is_400(monkeypatch, tmp_path):
    _loopback(monkeypatch)
    root = tmp_path / "cn"
    root.mkdir()
    (root / "plain").mkdir()
    _set_roots(root)
    resp = _post(pack.remote, name="plain", url="https://github.com/other/pack")
    assert resp.status == 400
    assert resp.json_body["code"] == "not_git"


def test_remote_switch_dirty_without_force_is_409(monkeypatch, tmp_path):
    _loopback(monkeypatch)
    pack_dir, origin, _, _ = _fork_setup(tmp_path)
    (pack_dir / "README.md").write_text("local edit\n")
    resp = _post(pack.remote, name="pack", url="https://github.com/other/pack")
    assert resp.status == 409
    assert resp.json_body["code"] == "dirty"
    # Refused before any git write: the remote and the edit both survive.
    assert pack._remote_url(str(pack_dir)) == str(origin)
    assert (pack_dir / "README.md").read_text() == "local edit\n"


def test_remote_switch_end_to_end_installs_the_new_deps(monkeypatch, tmp_path, stub_pip):
    _loopback(monkeypatch)
    pack_dir, _, fork, _ = _fork_setup(
        tmp_path, fork_files={"FORK.md": "fork\n", "requirements.txt": "numpy\n"}
    )
    # The URL gate is exercised on its own above; here it stands aside so the
    # real git switch can run against a local path with no network.
    monkeypatch.setattr(pack, "_validate_url", lambda url: ("pack", None))

    resp = _post(pack.remote, name="pack", url=str(fork))
    body = resp.json_body
    assert resp.status == 200
    assert body["ok"] is True
    assert body["name"] == "pack"
    assert body["ref"] == "main"
    assert body["remote_after"] == str(fork)
    assert body["restart_required"] is True
    assert body["deps"]["attempted"] is True
    assert body["deps"]["sources"] == ["requirements.txt"]
    assert (pack_dir / "FORK.md").is_file()
    assert len(stub_pip) == 1


def test_remote_switch_skips_pip_when_no_dependency_file_changed(monkeypatch, tmp_path, stub_pip):
    _loopback(monkeypatch)
    _, _, fork, _ = _fork_setup(tmp_path)
    monkeypatch.setattr(pack, "_validate_url", lambda url: ("pack", None))
    body = _post(pack.remote, name="pack", url=str(fork)).json_body
    assert body["deps"] == {
        "attempted": False,
        "ok": None,
        "sources": [],
        "error": None,
        "log": "",
    }
    assert stub_pip == []


def test_remote_switch_force_discards_local_changes(monkeypatch, tmp_path):
    _loopback(monkeypatch)
    pack_dir, _, fork, _ = _fork_setup(tmp_path)
    (pack_dir / "README.md").write_text("local edit\n")
    monkeypatch.setattr(pack, "_validate_url", lambda url: ("pack", None))

    resp = _post(pack.remote, name="pack", url=str(fork), force=True)
    assert resp.status == 200
    assert (pack_dir / "FORK.md").is_file()
    assert not (pack_dir / "README.md").exists()


# ===========================================================================
# Author + registry-source metadata (feeds /installed and the update flow)
# ===========================================================================


def _write_pyproject(path, *, name=None, version=None, publisher=None):
    lines = ["[project]"]
    if name is not None:
        lines.append(f'name = "{name}"')
    if version is not None:
        lines.append(f'version = "{version}"')
    if publisher is not None:
        lines.append("")
        lines.append("[tool.comfy]")
        lines.append(f'PublisherId = "{publisher}"')
    (path / "pyproject.toml").write_text("\n".join(lines) + "\n")


def test_owner_from_remote_parses_https_and_ssh():
    assert pack._owner_from_remote("https://github.com/owner/repo") == "owner"
    assert pack._owner_from_remote("https://github.com/owner/repo.git") == "owner"
    assert pack._owner_from_remote("https://gitlab.com/group/proj") == "group"
    assert pack._owner_from_remote("git@github.com:owner/repo.git") == "owner"
    assert pack._owner_from_remote("https://evil.example.com/owner/repo") is None
    assert pack._owner_from_remote(None) is None


def test_pyproject_publisher_reads_tool_comfy(tmp_path):
    _write_pyproject(tmp_path, name="foo", version="1.0.0", publisher="laurigates")
    assert pack._pyproject_publisher(str(tmp_path / "pyproject.toml")) == "laurigates"
    assert pack._pyproject_publisher(str(tmp_path / "missing.toml")) is None


def test_pack_author_prefers_remote_owner_over_publisher(tmp_path):
    _write_pyproject(tmp_path, name="foo", version="1.0.0", publisher="publisherid")
    assert pack._pack_author(str(tmp_path), "https://github.com/owner/repo") == "owner"
    assert pack._pack_author(str(tmp_path), None) == "publisherid"
    assert pack._pack_author(str(tmp_path), "https://evil.example.com/x/y") == "publisherid"


def test_pack_author_empty_when_nothing_resolves(tmp_path):
    assert pack._pack_author(str(tmp_path), None) == ""


def test_pyproject_project_meta_parses_name_and_version(tmp_path):
    _write_pyproject(tmp_path, name="comfyui-foo", version="1.2.0")
    meta = pack._pyproject_project_meta(str(tmp_path / "pyproject.toml"))
    assert meta == {"name": "comfyui-foo", "version": "1.2.0"}


def test_pyproject_project_meta_missing_file_is_empty(tmp_path):
    assert pack._pyproject_project_meta(str(tmp_path / "nope.toml")) == {
        "name": None,
        "version": None,
    }


def test_registry_source_meta_requires_name_and_version(tmp_path):
    pack_dir = tmp_path / "pack"
    pack_dir.mkdir()
    assert pack._registry_source_meta(str(pack_dir)) is None  # no pyproject.toml

    _write_pyproject(pack_dir, name="comfyui-foo")  # no version
    assert pack._registry_source_meta(str(pack_dir)) is None

    _write_pyproject(pack_dir, name="comfyui-foo", version="1.0.0")
    assert pack._registry_source_meta(str(pack_dir)) == {"id": "comfyui-foo", "version": "1.0.0"}


# ===========================================================================
# GET /touch_manager/installed — author/source/registry metadata per pack
# ===========================================================================


def test_installed_reports_author_and_source_for_git_pack(tmp_path):
    root = tmp_path / "cn"
    root.mkdir()
    origin = tmp_path / "origin.git"
    _init_bare(origin)
    seed = tmp_path / "seed"
    _init_seed(seed, origin)
    _clone(origin, root / "pack")
    _set_roots(root)

    packs = {p["name"]: p for p in _get(pack.installed).json_body["packs"]}
    p = packs["pack"]
    assert p["source"] == "git"
    assert p["registry_id"] is None
    assert p["installed_version"] is None
    # The local-path "origin" doesn't match github/gitlab, so no owner resolves.
    assert p["author"] == ""


def test_installed_reports_registry_source_for_non_git_pack(tmp_path):
    root = tmp_path / "cn"
    root.mkdir()
    pack_dir = root / "regpack"
    pack_dir.mkdir()
    _write_pyproject(pack_dir, name="regpack", version="2.0.0", publisher="someauthor")
    _set_roots(root)

    packs = {p["name"]: p for p in _get(pack.installed).json_body["packs"]}
    p = packs["regpack"]
    assert p["is_git"] is False
    assert p["source"] == "registry"
    assert p["registry_id"] == "regpack"
    assert p["installed_version"] == "2.0.0"
    assert p["author"] == "someauthor"


def test_installed_reports_unknown_source_for_plain_dir(tmp_path):
    root = tmp_path / "cn"
    root.mkdir()
    (root / "plain").mkdir()
    _set_roots(root)

    p = _get(pack.installed).json_body["packs"][0]
    assert p["source"] == "unknown"
    assert p["registry_id"] is None
    assert p["author"] == ""


# ===========================================================================
# updates/list + updates/check + update — registry-installed (non-git) packs
# ===========================================================================


def test_updates_list_includes_registry_packs(tmp_path):
    root = tmp_path / "cn"
    root.mkdir()
    origin = tmp_path / "origin.git"
    _init_bare(origin)
    seed = tmp_path / "seed"
    _init_seed(seed, origin)
    _clone(origin, root / "gitpack")
    (root / "plain").mkdir()  # no pyproject — still excluded
    reg = root / "regpack"
    reg.mkdir()
    _write_pyproject(reg, name="regpack", version="1.0.0")
    _set_roots(root)

    names = {p["name"] for p in _get(pack.updates_list).json_body["packs"]}
    assert names == {"gitpack", "regpack"}


def test_updates_check_registry_update_available(monkeypatch, tmp_path):
    root = tmp_path / "cn"
    root.mkdir()
    reg = root / "regpack"
    reg.mkdir()
    _write_pyproject(reg, name="regpack", version="1.0.0")
    _set_roots(root)

    monkeypatch.setattr(
        pack,
        "_registry_get",
        lambda path, params=None: {"latest_version": {"version": "1.2.0"}},
    )
    body = _get(pack.updates_check, name="regpack").json_body
    assert body["ok"] is True
    assert body["source"] == "registry"
    assert body["update_available"] is True
    assert body["latest_version"] == "1.2.0"


def test_updates_check_registry_up_to_date(monkeypatch, tmp_path):
    root = tmp_path / "cn"
    root.mkdir()
    reg = root / "regpack"
    reg.mkdir()
    _write_pyproject(reg, name="regpack", version="1.2.0")
    _set_roots(root)

    monkeypatch.setattr(
        pack,
        "_registry_get",
        lambda path, params=None: {"latest_version": {"version": "1.2.0"}},
    )
    body = _get(pack.updates_check, name="regpack").json_body
    assert body["update_available"] is False


def test_updates_check_registry_unavailable_degrades(monkeypatch, tmp_path):
    root = tmp_path / "cn"
    root.mkdir()
    reg = root / "regpack"
    reg.mkdir()
    _write_pyproject(reg, name="regpack", version="1.0.0")
    _set_roots(root)

    monkeypatch.setattr(pack, "_registry_get", lambda path, params=None: None)
    body = _get(pack.updates_check, name="regpack").json_body
    assert body["ok"] is True
    assert body["update_available"] is False
    assert body["error"] == "registry unavailable"


def _registry_update_setup(monkeypatch, tmp_path, *, current_version, archive, resolved_version):
    root = tmp_path / "cn"
    root.mkdir()
    reg = root / "regpack"
    reg.mkdir()
    _write_pyproject(reg, name="regpack", version=current_version)
    _set_roots(root)
    monkeypatch.setattr(
        pack,
        "_registry_get",
        lambda path, params=None: {
            "downloadUrl": "https://storage.googleapis.com/b/x.zip",
            "version": resolved_version,
        },
    )
    monkeypatch.setattr(pack, "_fetch_bytes", lambda url, cap: archive)
    return root, reg


def test_update_registry_pack_downloads_and_swaps(monkeypatch, tmp_path):
    archive = _zip_bytes({"pyproject.toml": '[project]\nname = "regpack"\nversion = "1.2.0"\n'})
    root, reg = _registry_update_setup(
        monkeypatch, tmp_path, current_version="1.0.0", archive=archive, resolved_version="1.2.0"
    )
    body = _post(pack.update, name="regpack").json_body
    assert body["ok"] is True
    assert body["source"] == "registry"
    assert body["before_version"] == "1.0.0"
    assert body["after_version"] == "1.2.0"
    assert body["commits_applied"] == 1
    assert body["restart_required"] is True
    installed_meta = pack._pyproject_project_meta(str(reg / "pyproject.toml"))
    assert installed_meta["version"] == "1.2.0"
    # No leftover staging/backup dirs.
    assert [p.name for p in root.iterdir()] == ["regpack"]


def test_update_registry_pack_no_op_when_already_latest(monkeypatch, tmp_path):
    _registry_update_setup(
        monkeypatch, tmp_path, current_version="1.2.0", archive=b"", resolved_version="1.2.0"
    )

    def boom(url, cap):  # a no-op update must never download
        raise AssertionError("should not fetch when already at the latest version")

    monkeypatch.setattr(pack, "_fetch_bytes", boom)
    body = _post(pack.update, name="regpack").json_body
    assert body["ok"] is True
    assert body["commits_applied"] == 0
    assert body["before_version"] == body["after_version"] == "1.2.0"


def test_update_registry_pack_download_failure_preserves_original(monkeypatch, tmp_path):
    root, reg = _registry_update_setup(
        monkeypatch, tmp_path, current_version="1.0.0", archive=b"", resolved_version="1.2.0"
    )

    def boom(url, cap):
        raise ValueError("archive exceeds size cap")

    monkeypatch.setattr(pack, "_fetch_bytes", boom)
    resp = _post(pack.update, name="regpack")
    assert resp.status == 500
    assert resp.json_body["code"] == "download_failed"
    # The original pack is untouched.
    assert pack._pyproject_project_meta(str(reg / "pyproject.toml"))["version"] == "1.0.0"
    assert [p.name for p in root.iterdir()] == ["regpack"]


def test_update_registry_pack_explicit_version(monkeypatch, tmp_path):
    archive = _zip_bytes({"pyproject.toml": '[project]\nname = "regpack"\nversion = "0.9.0"\n'})
    _registry_update_setup(
        monkeypatch, tmp_path, current_version="1.2.0", archive=archive, resolved_version="0.9.0"
    )
    body = _post(pack.update, name="regpack", version="0.9.0").json_body
    assert body["ok"] is True
    assert body["after_version"] == "0.9.0"


def test_update_registry_pack_invalid_version_is_400(tmp_path):
    root = tmp_path / "cn"
    root.mkdir()
    reg = root / "regpack"
    reg.mkdir()
    _write_pyproject(reg, name="regpack", version="1.0.0")
    _set_roots(root)
    resp = _post(pack.update, name="regpack", version="../bad")
    assert resp.status == 400
    assert resp.json_body["code"] == "invalid_version"


# ===========================================================================
# POST /touch_manager/uninstall
# ===========================================================================


def test_uninstall_renames_to_disabled(tmp_path):
    root = tmp_path / "cn"
    root.mkdir()
    (root / "pack").mkdir()
    _set_roots(root)
    resp = _post(pack.uninstall, name="pack")
    assert resp.status == 200
    assert resp.json_body["ok"] is True
    assert resp.json_body["restart_required"] is True
    assert not (root / "pack").exists()
    assert (root / "pack.disabled").is_dir()


def test_uninstall_not_found(tmp_path):
    root = tmp_path / "cn"
    root.mkdir()
    _set_roots(root)
    resp = _post(pack.uninstall, name="ghost")
    assert resp.status == 404
    assert resp.json_body["code"] == "not_found"


def test_uninstall_rejects_unsafe_name(tmp_path):
    root = tmp_path / "cn"
    root.mkdir()
    _set_roots(root)
    resp = _post(pack.uninstall, name="../escape")
    assert resp.status == 404
    assert resp.json_body["code"] == "not_found"


# ===========================================================================
# POST /touch_manager/enable
# ===========================================================================


def test_enable_renames_from_disabled(tmp_path):
    root = tmp_path / "cn"
    root.mkdir()
    (root / "pack.disabled").mkdir()
    _set_roots(root)
    resp = _post(pack.enable, name="pack")
    assert resp.status == 200
    assert resp.json_body["ok"] is True
    assert resp.json_body["restart_required"] is True
    assert (root / "pack").is_dir()
    assert not (root / "pack.disabled").exists()


def test_enable_round_trips_with_uninstall(tmp_path):
    # Disable then enable returns the pack to its original enabled directory.
    root = tmp_path / "cn"
    root.mkdir()
    (root / "pack").mkdir()
    _set_roots(root)
    assert _post(pack.uninstall, name="pack").status == 200
    assert (root / "pack.disabled").is_dir()
    assert _post(pack.enable, name="pack").status == 200
    assert (root / "pack").is_dir()
    assert not (root / "pack.disabled").exists()


def test_enable_already_enabled_is_noop(tmp_path):
    root = tmp_path / "cn"
    root.mkdir()
    (root / "pack").mkdir()
    _set_roots(root)
    resp = _post(pack.enable, name="pack")
    assert resp.status == 200
    assert resp.json_body["restart_required"] is False
    assert (root / "pack").is_dir()


def test_enable_not_found(tmp_path):
    root = tmp_path / "cn"
    root.mkdir()
    _set_roots(root)
    resp = _post(pack.enable, name="ghost")
    assert resp.status == 404
    assert resp.json_body["code"] == "not_found"


def test_enable_rejects_unsafe_name(tmp_path):
    root = tmp_path / "cn"
    root.mkdir()
    _set_roots(root)
    resp = _post(pack.enable, name="../escape")
    assert resp.status == 404
    assert resp.json_body["code"] == "not_found"


# ===========================================================================
# POST /touch_manager/delete — irreversible removal
# ===========================================================================


@pytest.mark.parametrize(
    ("listen", "remote_env", "expected"),
    [
        ("", None, True),  # loopback → allowed by default
        ("127.0.0.1", None, True),
        ("0.0.0.0", None, False),  # non-loopback, no opt-in → denied
        ("0.0.0.0", "1", True),  # non-loopback + remote opt-in → allowed
        ("192.168.1.10", None, False),
    ],
)
def test_delete_gate_predicate(monkeypatch, listen, remote_env, expected):
    monkeypatch.setattr(comfy.cli_args.args, "listen", listen)
    if remote_env is None:
        monkeypatch.delenv("TOUCH_MANAGER_ALLOW_REMOTE_DELETE", raising=False)
    else:
        monkeypatch.setenv("TOUCH_MANAGER_ALLOW_REMOTE_DELETE", remote_env)
    assert pack._delete_allowed() is expected


def _deletable(monkeypatch, tmp_path, name="pack", *, contents=True):
    """A loopback bind and one pack directory with a file in it."""
    monkeypatch.setattr(comfy.cli_args.args, "listen", "")
    monkeypatch.delenv("TOUCH_MANAGER_ALLOW_REMOTE_DELETE", raising=False)
    root = tmp_path / "cn"
    root.mkdir()
    target = root / name
    target.mkdir()
    if contents:
        (target / "node.py").write_text("x\n")
    _set_roots(root)
    return root, target


def test_delete_removes_the_pack_directory(monkeypatch, tmp_path):
    root, target = _deletable(monkeypatch, tmp_path)
    resp = _post(pack.delete, name="pack")
    assert resp.status == 200
    assert resp.json_body["ok"] is True
    assert resp.json_body["restart_required"] is True
    assert not target.exists()
    assert root.is_dir()  # only the pack went


def test_delete_removes_a_disabled_pack(monkeypatch, tmp_path):
    root, _ = _deletable(monkeypatch, tmp_path, "pack.disabled")
    resp = _post(pack.delete, name="pack")
    assert resp.status == 200
    assert not (root / "pack.disabled").exists()


def test_delete_not_found(monkeypatch, tmp_path):
    _deletable(monkeypatch, tmp_path)
    resp = _post(pack.delete, name="ghost")
    assert resp.status == 404
    assert resp.json_body["code"] == "not_found"


def test_delete_rejects_unsafe_name(monkeypatch, tmp_path):
    root, target = _deletable(monkeypatch, tmp_path)
    resp = _post(pack.delete, name="../cn")
    assert resp.status == 404
    assert resp.json_body["code"] == "not_found"
    assert target.is_dir()
    assert root.is_dir()


def test_delete_blocked_on_non_loopback(monkeypatch, tmp_path):
    _, target = _deletable(monkeypatch, tmp_path)
    monkeypatch.setattr(comfy.cli_args.args, "listen", "0.0.0.0")
    resp = _post(pack.delete, name="pack")
    assert resp.status == 403
    assert resp.json_body["code"] == "delete_disabled"
    assert target.is_dir()  # nothing removed


def test_delete_allowed_on_non_loopback_with_remote_env(monkeypatch, tmp_path):
    _, target = _deletable(monkeypatch, tmp_path)
    monkeypatch.setattr(comfy.cli_args.args, "listen", "0.0.0.0")
    monkeypatch.setenv("TOUCH_MANAGER_ALLOW_REMOTE_DELETE", "1")
    assert _post(pack.delete, name="pack").status == 200
    assert not target.exists()


def test_delete_refuses_a_symlinked_pack_and_spares_its_target(monkeypatch, tmp_path):
    # A pack dir that is a symlink resolves OUTSIDE its custom_nodes root —
    # deleting through it would take someone else's files with it.
    monkeypatch.setattr(comfy.cli_args.args, "listen", "")
    root = tmp_path / "cn"
    root.mkdir()
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    (outside / "keep.txt").write_text("keep\n")
    os.symlink(outside, root / "pack")
    _set_roots(root)

    resp = _post(pack.delete, name="pack")
    assert resp.status == 400
    assert resp.json_body["code"] == "invalid_target"
    assert (outside / "keep.txt").is_file()
    assert (root / "pack").is_symlink()


def test_delete_reports_a_filesystem_failure(monkeypatch, tmp_path):
    _deletable(monkeypatch, tmp_path)

    def boom(path):
        raise OSError("device busy")

    monkeypatch.setattr(pack.shutil, "rmtree", boom)
    resp = _post(pack.delete, name="pack")
    assert resp.status == 500
    assert resp.json_body["code"] == "delete_failed"
    assert "device busy" in resp.json_body["error"]


# ===========================================================================
# GET /touch_manager/core
# ===========================================================================


def test_core_reports_git_state(tmp_path):
    origin = tmp_path / "origin.git"
    _init_bare(origin)
    seed = tmp_path / "seed"
    _init_seed(seed, origin)
    core_dir = tmp_path / "ComfyUI"
    _clone(origin, core_dir)
    folder_paths.base_path = str(core_dir)

    resp = _get(pack.core)
    assert resp.status == 200
    body = resp.json_body
    assert body["ok"] is True
    assert body["is_git"] is True
    assert body["ref"]["type"] == "branch"
    assert body["remotes"]["origin"] == str(origin)
    assert body["remotes"]["upstream"] is None
    assert body["behind"]["origin"] == 0


def test_core_non_git(tmp_path):
    plain = tmp_path / "plaincore"
    plain.mkdir()
    folder_paths.base_path = str(plain)
    body = _get(pack.core).json_body
    assert body["is_git"] is False
    assert body["behind"] == {"origin": None, "upstream": None}
    assert body["remotes"] == {"origin": None, "upstream": None}


# ===========================================================================
# POST /touch_manager/core/update
# ===========================================================================


def test_core_update_not_git(tmp_path):
    plain = tmp_path / "plaincore"
    plain.mkdir()
    folder_paths.base_path = str(plain)
    resp = _post(pack.core_update)
    assert resp.status == 400
    assert resp.json_body["code"] == "not_git"


def test_core_update_deps_changed_true(tmp_path):
    origin = tmp_path / "origin.git"
    _init_bare(origin)
    seed = tmp_path / "seed"
    _init_seed(seed, origin)
    core_dir = tmp_path / "ComfyUI"
    _clone(origin, core_dir)
    _advance(seed, fname="requirements.txt", content="numpy\n")  # touches reqs
    folder_paths.base_path = str(core_dir)

    resp = _post(pack.core_update)
    assert resp.status == 200
    assert resp.json_body["ok"] is True
    assert resp.json_body["deps_changed"] is True
    assert resp.json_body["restart_required"] is True


def test_core_update_deps_changed_false(tmp_path):
    origin = tmp_path / "origin.git"
    _init_bare(origin)
    seed = tmp_path / "seed"
    _init_seed(seed, origin)
    core_dir = tmp_path / "ComfyUI"
    _clone(origin, core_dir)
    _advance(seed, fname="other.txt", content="x\n")  # no requirements change
    folder_paths.base_path = str(core_dir)

    body = _post(pack.core_update).json_body
    assert body["deps_changed"] is False


# ===========================================================================
# Comfy Registry — pure guards
# ===========================================================================


@pytest.mark.parametrize(
    ("url", "ok"),
    [
        ("https://cdn.comfy.org/pub/node/1.2.0/node.zip", True),
        ("https://api.comfy.org/x/y.zip", True),
        ("https://storage.googleapis.com/bucket/a.zip", True),
        ("http://cdn.comfy.org/pub/node.zip", False),  # not https
        ("http://storage.googleapis.com/a.zip", False),  # not https
        ("https://github.com/owner/repo/archive/main.zip", False),  # host not allowed
        ("https://evil.example.com/a.zip", False),
        ("ftp://storage.googleapis.com/a.zip", False),
        (None, False),
        (123, False),
    ],
)
def test_validate_archive_url(url, ok):
    assert pack._validate_archive_url(url) is ok


@pytest.mark.parametrize("version", ["1.2.3", "v1.2.3", "1.0.0-rc.1", "2024.1.0+build"])
def test_safe_version_accepts_normal(version):
    assert pack._safe_version(version) == version


@pytest.mark.parametrize("version", ["", None, 123, "-x", "../etc", "a/b", "a\\b", "x;y"])
def test_safe_version_rejects_bad(version):
    assert pack._safe_version(version) is None


@pytest.mark.parametrize(
    ("raw", "expected"), [("1", 1), ("5", 5), ("0", 1), ("-3", 1), ("nope", 1), (None, 1)]
)
def test_coerce_page(raw, expected):
    assert pack._coerce_page(raw) == expected


# ===========================================================================
# GET /touch_manager/registry/search + /registry/versions (urllib mocked)
# ===========================================================================


def test_registry_search_normalizes(monkeypatch):
    raw = {
        "page": 1,
        "totalPages": 3,
        "nodes": [
            {
                "id": "comfyui-foo",
                "name": "Foo",
                "description": "does foo",
                "downloads": 42,
                "repository": "https://github.com/o/comfyui-foo",
                "publisher": {"name": "octocat"},
                "latest_version": {"version": "1.4.0"},
            },
            "not-a-dict",  # must be skipped
        ],
    }
    monkeypatch.setattr(pack, "_registry_get", lambda path, params=None: raw)
    body = _get(pack.registry_search, q="foo").json_body
    assert body["ok"] is True
    assert body["total_pages"] == 3
    assert len(body["nodes"]) == 1
    node = body["nodes"][0]
    assert node["id"] == "comfyui-foo"
    assert node["author"] == "octocat"
    assert node["latest_version"] == "1.4.0"
    assert node["downloads"] == 42


def test_registry_search_upstream_failure_is_502(monkeypatch):
    monkeypatch.setattr(pack, "_registry_get", lambda path, params=None: None)
    resp = _get(pack.registry_search, q="foo")
    assert resp.status == 502
    assert resp.json_body["code"] == "registry_unavailable"


def test_registry_versions_lists(monkeypatch):
    monkeypatch.setattr(
        pack,
        "_registry_get",
        lambda path, params=None: {
            "versions": [
                {"version": "1.0.0", "deprecated": False},
                {"version": "0.9.0", "deprecated": True},
                {"no_version": True},  # skipped
            ]
        },
    )
    body = _get(pack.registry_versions, id="comfyui-foo").json_body
    assert [v["version"] for v in body["versions"]] == ["1.0.0", "0.9.0"]
    assert body["versions"][1]["deprecated"] is True


def test_registry_versions_invalid_id_is_400(monkeypatch):
    resp = _get(pack.registry_versions, id="../evil")
    assert resp.status == 400
    assert resp.json_body["code"] == "invalid_id"


# ===========================================================================
# POST /touch_manager/registry/install (download + safe extract)
# ===========================================================================


def _zip_bytes(members: dict[str, str]) -> bytes:
    """Build an in-memory zip from {arcname: text}."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, text in members.items():
            zf.writestr(name, text)
    return buf.getvalue()


def _registry_install_setup(monkeypatch, tmp_path, archive: bytes):
    root = tmp_path / "cn"
    root.mkdir()
    _set_roots(root)
    monkeypatch.setattr(comfy.cli_args.args, "listen", "")
    monkeypatch.delenv("TOUCH_MANAGER_ALLOW_REMOTE_INSTALL", raising=False)
    monkeypatch.setattr(
        pack,
        "_registry_get",
        lambda path, params=None: {"downloadUrl": "https://storage.googleapis.com/b/x.zip"},
    )
    monkeypatch.setattr(pack, "_fetch_bytes", lambda url, cap: archive)
    return root


def test_registry_install_happy_path(monkeypatch, tmp_path):
    archive = _zip_bytes({"__init__.py": "# node\n", "requirements.txt": "numpy\n"})
    root = _registry_install_setup(monkeypatch, tmp_path, archive)
    body = _post(pack.registry_install, id="comfyui-foo", version="1.0.0").json_body

    assert body["ok"] is True
    assert body["source"] == "registry"
    assert body["deps_changed"] is True
    assert body["restart_required"] is True
    target = root / "comfyui-foo"
    assert (target / "__init__.py").is_file()
    assert (target / "requirements.txt").is_file()
    # No staging dirs left behind.
    assert [p.name for p in root.iterdir()] == ["comfyui-foo"]


def test_registry_install_unwraps_single_dir(monkeypatch, tmp_path):
    archive = _zip_bytes({"comfyui-foo-1.0.0/__init__.py": "# node\n"})
    root = _registry_install_setup(monkeypatch, tmp_path, archive)
    _post(pack.registry_install, id="comfyui-foo")
    assert (root / "comfyui-foo" / "__init__.py").is_file()


def test_registry_install_rejects_zip_slip(monkeypatch, tmp_path):
    archive = _zip_bytes({"../evil.txt": "pwned\n", "__init__.py": "x\n"})
    root = _registry_install_setup(monkeypatch, tmp_path, archive)
    resp = _post(pack.registry_install, id="comfyui-foo")
    assert resp.status == 500
    assert resp.json_body["code"] == "extract_failed"
    assert not (root / "comfyui-foo").exists()
    assert not (tmp_path / "evil.txt").exists()  # never escaped
    # Staging cleaned up — only nothing (or no leftover) remains.
    assert list(root.iterdir()) == []


def test_registry_install_rejects_existing_target(monkeypatch, tmp_path):
    archive = _zip_bytes({"__init__.py": "x\n"})
    root = _registry_install_setup(monkeypatch, tmp_path, archive)
    (root / "comfyui-foo").mkdir()
    resp = _post(pack.registry_install, id="comfyui-foo")
    assert resp.status == 409
    assert resp.json_body["code"] == "exists"


def test_registry_install_blocked_on_non_loopback(monkeypatch, tmp_path):
    archive = _zip_bytes({"__init__.py": "x\n"})
    root = _registry_install_setup(monkeypatch, tmp_path, archive)
    monkeypatch.setattr(comfy.cli_args.args, "listen", "0.0.0.0")
    resp = _post(pack.registry_install, id="comfyui-foo")
    assert resp.status == 403
    assert resp.json_body["code"] == "blocked_remote_bind"
    assert not (root / "comfyui-foo").exists()


def test_registry_install_invalid_version_is_400(monkeypatch, tmp_path):
    archive = _zip_bytes({"__init__.py": "x\n"})
    _registry_install_setup(monkeypatch, tmp_path, archive)
    resp = _post(pack.registry_install, id="comfyui-foo", version="../bad")
    assert resp.status == 400
    assert resp.json_body["code"] == "invalid_version"


def test_registry_install_unsupported_download_host_is_502(monkeypatch, tmp_path):
    root = tmp_path / "cn"
    root.mkdir()
    _set_roots(root)
    monkeypatch.setattr(comfy.cli_args.args, "listen", "")
    monkeypatch.setattr(
        pack,
        "_registry_get",
        lambda path, params=None: {"downloadUrl": "https://evil.example.com/x.zip"},
    )
    resp = _post(pack.registry_install, id="comfyui-foo")
    assert resp.status == 502
    assert resp.json_body["code"] == "invalid_archive_url"


def test_registry_install_download_failure_degrades(monkeypatch, tmp_path):
    def boom(url, cap):
        raise ValueError("archive exceeds size cap")

    root = _registry_install_setup(monkeypatch, tmp_path, b"")
    monkeypatch.setattr(pack, "_fetch_bytes", boom)
    resp = _post(pack.registry_install, id="comfyui-foo")
    assert resp.status == 500
    assert resp.json_body["code"] == "download_failed"
    assert list(root.iterdir()) == []


class _FakeResp:
    def __init__(self, data):
        self._d = data

    def read(self, n=-1):
        return self._d[:n] if n is not None and n >= 0 else self._d

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def test_fetch_bytes_enforces_cap(monkeypatch):
    monkeypatch.setattr(pack.urllib.request, "urlopen", lambda *a, **k: _FakeResp(b"x" * 100))
    with pytest.raises(ValueError, match="size cap"):
        pack._fetch_bytes("https://storage.googleapis.com/x.zip", 10)


def test_fetch_bytes_returns_data(monkeypatch):
    monkeypatch.setattr(pack.urllib.request, "urlopen", lambda *a, **k: _FakeResp(b"hello"))
    assert pack._fetch_bytes("https://storage.googleapis.com/x.zip", 1000) == b"hello"


# ===========================================================================
# POST /touch_manager/reboot
# ===========================================================================


def _patch_execv(monkeypatch):
    """Record os.execv calls instead of replacing the test process."""
    calls = []
    monkeypatch.setattr(pack.os, "execv", lambda *a: calls.append(a))
    return calls


@pytest.mark.parametrize(
    ("listen", "remote_env", "expected"),
    [
        ("", None, True),  # loopback → allowed by default
        ("127.0.0.1", None, True),
        ("0.0.0.0", None, False),  # non-loopback, no opt-in → denied
        ("0.0.0.0", "1", True),  # non-loopback + remote opt-in → allowed
        ("192.168.1.10", None, False),
    ],
)
def test_reboot_gate_predicate(monkeypatch, listen, remote_env, expected):
    monkeypatch.setattr(comfy.cli_args.args, "listen", listen)
    if remote_env is None:
        monkeypatch.delenv("TOUCH_MANAGER_ALLOW_REMOTE_REBOOT", raising=False)
    else:
        monkeypatch.setenv("TOUCH_MANAGER_ALLOW_REMOTE_REBOOT", remote_env)
    assert pack._reboot_allowed() is expected


def test_reboot_allowed_on_loopback(monkeypatch):
    monkeypatch.delenv("TOUCH_MANAGER_ALLOW_REMOTE_REBOOT", raising=False)
    monkeypatch.setattr(comfy.cli_args.args, "listen", "")
    calls = _patch_execv(monkeypatch)
    resp = _post(pack.reboot)
    # The gate passed: execv was reached (mocked) and the handler returned ok.
    assert len(calls) == 1
    assert resp.json_body["ok"] is True


def test_reboot_disabled_on_non_loopback_without_env(monkeypatch):
    monkeypatch.delenv("TOUCH_MANAGER_ALLOW_REMOTE_REBOOT", raising=False)
    monkeypatch.setattr(comfy.cli_args.args, "listen", "0.0.0.0")
    calls = _patch_execv(monkeypatch)
    resp = _post(pack.reboot)
    assert resp.status == 403
    assert resp.json_body == {
        "ok": False,
        "error": "reboot disabled",
        "code": "reboot_disabled",
    }
    assert calls == []  # execv never reached


def test_reboot_allowed_on_non_loopback_with_remote_env(monkeypatch):
    monkeypatch.setenv("TOUCH_MANAGER_ALLOW_REMOTE_REBOOT", "1")
    monkeypatch.setattr(comfy.cli_args.args, "listen", "0.0.0.0")
    calls = _patch_execv(monkeypatch)
    resp = _post(pack.reboot)
    assert len(calls) == 1
    assert resp.json_body["ok"] is True


# ===========================================================================
# Error envelope contract
# ===========================================================================


def test_error_envelope_shape(monkeypatch, tmp_path):
    monkeypatch.setattr(comfy.cli_args.args, "listen", "")
    root = tmp_path / "cn"
    root.mkdir()
    _set_roots(root)
    resp = _post(pack.install, url="nope")
    assert set(resp.json_body) == {"ok", "error", "code"}
    assert resp.json_body["ok"] is False
    assert isinstance(resp.json_body["error"], str)
    assert isinstance(resp.json_body["code"], str)


# ===========================================================================
# Dependency installation (pip)
# ===========================================================================


def test_pyproject_deps_parses_project_dependencies(tmp_path):
    (tmp_path / "pyproject.toml").write_text(
        '[project]\nname = "x"\ndependencies = ["numpy>=1.0", "pillow"]\n'
        '[build-system]\nrequires = ["setuptools"]\n'
    )
    # build-system.requires must NOT leak in — only [project.dependencies].
    assert pack._pyproject_deps(str(tmp_path / "pyproject.toml")) == ["numpy>=1.0", "pillow"]


def test_pyproject_deps_missing_or_empty_is_empty(tmp_path):
    (tmp_path / "no-deps.toml").write_text('[project]\nname = "x"\n')
    assert pack._pyproject_deps(str(tmp_path / "no-deps.toml")) == []
    assert pack._pyproject_deps(str(tmp_path / "does-not-exist.toml")) == []


def test_pyproject_deps_bad_toml_is_empty(tmp_path):
    (tmp_path / "bad.toml").write_text("this is = = not toml [[[")
    assert pack._pyproject_deps(str(tmp_path / "bad.toml")) == []


def test_install_deps_runs_requirements(tmp_path, stub_pip):
    (tmp_path / "requirements.txt").write_text("numpy\n")
    result = pack._install_deps(str(tmp_path))
    assert result["attempted"] is True
    assert result["ok"] is True
    assert result["sources"] == ["requirements.txt"]
    # pip install -r <path>, run in the pack dir.
    ((args, cwd),) = stub_pip
    assert args == ["-r", os.path.join(str(tmp_path), "requirements.txt")]
    assert cwd == str(tmp_path)


def test_install_deps_runs_pyproject_with_option_guard(tmp_path, stub_pip):
    (tmp_path / "pyproject.toml").write_text(
        '[project]\nname = "x"\ndependencies = ["numpy>=1.0"]\n'
    )
    result = pack._install_deps(str(tmp_path))
    assert result["attempted"] is True
    assert result["sources"] == ["pyproject.toml"]
    # "--" stops pip option parsing before the specs (argument-injection guard).
    ((args, _cwd),) = stub_pip
    assert args == ["--", "numpy>=1.0"]


def test_install_deps_runs_both_sources(tmp_path, stub_pip):
    (tmp_path / "requirements.txt").write_text("numpy\n")
    (tmp_path / "pyproject.toml").write_text('[project]\nname = "x"\ndependencies = ["pillow"]\n')
    result = pack._install_deps(str(tmp_path))
    assert result["sources"] == ["requirements.txt", "pyproject.toml"]
    assert len(stub_pip) == 2  # one invocation per source


def test_install_deps_no_files_does_not_run_pip(tmp_path, stub_pip):
    result = pack._install_deps(str(tmp_path))
    assert result == {"attempted": False, "ok": None, "sources": [], "error": None, "log": ""}
    assert stub_pip == []


def test_install_deps_reports_pip_failure(monkeypatch, tmp_path):
    (tmp_path / "requirements.txt").write_text("numpy\n")
    monkeypatch.setattr(pack, "_pip_install", lambda args, cwd, timeout=300: (1, "boom"))
    result = pack._install_deps(str(tmp_path))
    assert result["attempted"] is True
    assert result["ok"] is False
    assert "pip exited 1" in result["error"]
    assert "boom" in result["log"]


def test_update_installs_deps_when_requirements_changed(tmp_path, stub_pip):
    root = tmp_path / "cn"
    root.mkdir()
    origin = tmp_path / "origin.git"
    _init_bare(origin)
    seed = tmp_path / "seed"
    _init_seed(seed, origin)
    _clone(origin, root / "pack")
    _advance(seed, fname="requirements.txt", content="numpy\n")
    _set_roots(root)

    body = _post(pack.update, name="pack").json_body
    assert body["deps_changed"] is True
    assert body["deps"]["attempted"] is True
    assert body["deps"]["ok"] is True
    # pip actually ran, targeting the updated pack.
    ((args, cwd),) = stub_pip
    assert args[0] == "-r"
    assert cwd == str(root / "pack")


def test_update_skips_deps_install_when_nothing_relevant_changed(tmp_path, stub_pip):
    root = tmp_path / "cn"
    root.mkdir()
    origin = tmp_path / "origin.git"
    _init_bare(origin)
    seed = tmp_path / "seed"
    _init_seed(seed, origin)
    _clone(origin, root / "pack")
    _advance(seed)  # touches README.md only
    _set_roots(root)

    body = _post(pack.update, name="pack").json_body
    assert body["deps_changed"] is False
    assert body["deps"]["attempted"] is False
    assert stub_pip == []  # no wasted pip resolve


def test_update_installs_deps_on_pyproject_change(tmp_path, stub_pip):
    root = tmp_path / "cn"
    root.mkdir()
    origin = tmp_path / "origin.git"
    _init_bare(origin)
    seed = tmp_path / "seed"
    _init_seed(seed, origin)
    _clone(origin, root / "pack")
    _advance(
        seed,
        fname="pyproject.toml",
        content='[project]\nname = "p"\ndependencies = ["pillow"]\n',
    )
    _set_roots(root)

    body = _post(pack.update, name="pack").json_body
    assert body["deps_changed"] is True
    assert body["deps"]["sources"] == ["pyproject.toml"]


def test_core_update_installs_deps(tmp_path, stub_pip):
    origin = tmp_path / "origin.git"
    _init_bare(origin)
    seed = tmp_path / "seed"
    _init_seed(seed, origin)
    core_dir = tmp_path / "ComfyUI"
    _clone(origin, core_dir)
    _advance(seed, fname="requirements.txt", content="numpy\n")
    folder_paths.base_path = str(core_dir)

    body = _post(pack.core_update).json_body
    assert body["deps_changed"] is True
    assert body["deps"]["attempted"] is True
    ((args, cwd),) = stub_pip
    assert args[0] == "-r"
    assert cwd == str(core_dir)


def test_install_installs_deps_from_clone(monkeypatch, tmp_path, stub_pip):
    monkeypatch.setattr(comfy.cli_args.args, "listen", "")
    root = tmp_path / "cn"
    root.mkdir()
    _set_roots(root)

    def fake_git(args, cwd, timeout=60):
        if args[0] == "clone":
            target = args[2]
            os.makedirs(target, exist_ok=True)
            # A real clone lands the pack's requirements.txt.
            with open(os.path.join(target, "requirements.txt"), "w") as fh:
                fh.write("numpy\n")
        return 0, "", ""

    monkeypatch.setattr(pack, "_git", fake_git)
    body = _post(pack.install, url="https://github.com/owner/repo").json_body
    assert body["ok"] is True
    assert body["deps"]["attempted"] is True
    ((args, cwd),) = stub_pip
    assert args[0] == "-r"
    assert cwd == str(root / "repo")


def test_registry_install_installs_deps(monkeypatch, tmp_path, stub_pip):
    archive = _zip_bytes({"__init__.py": "# node\n", "requirements.txt": "numpy\n"})
    root = _registry_install_setup(monkeypatch, tmp_path, archive)
    body = _post(pack.registry_install, id="comfyui-foo").json_body
    assert body["deps_changed"] is True
    assert body["deps"]["attempted"] is True
    ((args, cwd),) = stub_pip
    assert args[0] == "-r"
    assert cwd == str(root / "comfyui-foo")
