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
import os
import subprocess

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


def _init_bare(path):
    path.mkdir(parents=True, exist_ok=True)
    _git(path, "init", "--bare", "-b", "main")


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
    resp = _get(pack.config)
    assert resp.status == 200
    body = resp.json_body
    assert body["ok"] is True
    assert body["is_loopback"] is True
    assert body["allow_remote_install"] is False
    assert body["manager_enabled"] is True


def test_config_non_loopback_with_override(monkeypatch):
    monkeypatch.setattr(comfy.cli_args.args, "listen", "0.0.0.0")
    monkeypatch.setenv("TOUCH_MANAGER_ALLOW_REMOTE_INSTALL", "1")
    body = _get(pack.config).json_body
    assert body["is_loopback"] is False
    assert body["allow_remote_install"] is True


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
# GET /touch_manager/updates — behind/ahead via a local origin
# ===========================================================================


def test_updates_reports_behind(tmp_path):
    root = tmp_path / "cn"
    root.mkdir()
    origin = tmp_path / "origin.git"
    _init_bare(origin)
    seed = tmp_path / "seed"
    _init_seed(seed, origin)
    _clone(origin, root / "pack")
    _advance(seed)  # origin now one commit ahead of the cloned pack

    _set_roots(root)
    resp = _get(pack.updates)
    assert resp.status == 200
    entry = {p["name"]: p for p in resp.json_body["packs"]}["pack"]
    assert entry["update_available"] is True
    assert entry["behind"] == 1
    assert entry["ahead"] == 0
    assert entry["error"] is None


def test_updates_up_to_date(tmp_path):
    root = tmp_path / "cn"
    root.mkdir()
    origin = tmp_path / "origin.git"
    _init_bare(origin)
    seed = tmp_path / "seed"
    _init_seed(seed, origin)
    _clone(origin, root / "pack")

    _set_roots(root)
    entry = {p["name"]: p for p in _get(pack.updates).json_body["packs"]}["pack"]
    assert entry["update_available"] is False
    assert entry["behind"] == 0


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
# POST /touch_manager/reboot
# ===========================================================================


def test_reboot_disabled_by_default(monkeypatch):
    monkeypatch.delenv("TOUCH_MANAGER_ALLOW_REBOOT", raising=False)
    monkeypatch.setattr(comfy.cli_args.args, "listen", "")
    resp = _post(pack.reboot)
    assert resp.status == 403
    assert resp.json_body == {
        "ok": False,
        "error": "reboot disabled",
        "code": "reboot_disabled",
    }


def test_reboot_disabled_on_non_loopback_even_with_env(monkeypatch):
    # Both conditions are required: env opt-in is not enough off loopback.
    monkeypatch.setenv("TOUCH_MANAGER_ALLOW_REBOOT", "1")
    monkeypatch.setattr(comfy.cli_args.args, "listen", "0.0.0.0")
    resp = _post(pack.reboot)
    assert resp.status == 403
    assert resp.json_body["code"] == "reboot_disabled"


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
