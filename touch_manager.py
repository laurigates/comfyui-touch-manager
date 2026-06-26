"""Touch Node Manager — backend node + HTTP endpoints.

A touch-first node/extension manager for ComfyUI. The backend performs
self-contained git operations (enumerate installed packs, check for updates,
install from a URL, switch versions, update core) behind a small JSON HTTP
surface the frontend modal drives. It restarts NOTHING — every mutating route
just sets ``restart_required: true`` and leaves the restart to the user.

Uses ComfyUI-bundled libraries ONLY (aiohttp, plus folder_paths / server from
ComfyUI core) and the Python standard library (subprocess, os, asyncio, json,
re, urllib). Do not add a Python dependency that ComfyUI does not already ship.

Route surface (all under /touch_manager/, all return {"ok": bool, ...}; errors
are {"ok": false, "error": <msg>, "code": <slug>} with a matching HTTP status):

  GET  /touch_manager/config      — bind/security gates the frontend reflects
  GET  /touch_manager/installed   — every pack dir across all custom_nodes roots
  GET  /touch_manager/updates     — per-pack behind/ahead vs upstream (fetches)
  GET  /touch_manager/versions    — branches/tags/releases for one pack
  POST /touch_manager/install     — clone a github/gitlab URL into roots[0]
  POST /touch_manager/update      — fetch + checkout/ff one pack
  POST /touch_manager/uninstall   — reversible disable (rename to .disabled)
  GET  /touch_manager/core        — core repo ref/behind/dirty/remotes
  POST /touch_manager/core/update — git pull core; report requirements drift
  POST /touch_manager/reboot      — opt-in os.execv stub (disabled by default)

Security perimeter (enforced here, surfaced in the frontend via /config):
  - Bind gate: /install is refused on a NON-loopback bind unless the operator
    sets TOUCH_MANAGER_ALLOW_REMOTE_INSTALL=1.
  - URL allowlist: https github.com / gitlab.com only; the derived directory
    name is sanitised to [A-Za-z0-9._-] and path-traversal-guarded against the
    install root.
  - git is always invoked with an argument LIST (never shell=True), with a
    timeout and an explicit cwd. No caller string is interpolated into a shell.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import subprocess
import sys
import urllib.request
from json import JSONDecodeError, loads
from typing import Any

import folder_paths
from aiohttp import web
from server import PromptServer

log = logging.getLogger("comfyui-touch-manager")

# Only these hosts may be cloned from. Keep it tight: an https URL on a known
# forge with an owner/repo path, optional trailing .git. Anything else is
# rejected before a single subprocess runs.
ALLOWED_HOSTS = {"github.com", "gitlab.com"}

# Characters permitted in a derived install directory name. Anything outside
# this set (path separators, "..", control chars) is rejected so a crafted URL
# tail cannot escape the install root.
_NAME_RE = re.compile(r"^[A-Za-z0-9._-]+$")

# A listen address counts as loopback (the safe default) when it is one of
# these spellings. Empty string is ComfyUI's default bind (loopback).
_LOOPBACK = {"", "127.0.0.1", "localhost", "::1"}

_DISABLED_SUFFIX = ".disabled"


# ---------------------------------------------------------------------------
# git + process helpers (all blocking; call via _run off the event loop)
# ---------------------------------------------------------------------------


def _git(args: list[str], cwd: str, timeout: int = 60) -> tuple[int, str, str]:
    """Run ``git <args>`` in ``cwd`` and return (returncode, stdout, stderr).

    Never raises: a timeout maps to rc 124, a missing/broken git binary to
    127. Always a LIST of args (never shell=True) so no caller string is ever
    interpolated into a shell.
    """
    try:
        proc = subprocess.run(
            ["git", *args],
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return 124, "", "git timed out"
    except OSError as exc:
        return 127, "", str(exc)
    return proc.returncode, proc.stdout, proc.stderr


async def _run(func: Any, *args: Any) -> Any:
    """Run a blocking callable off the event loop (mirrors model_gallery)."""
    return await asyncio.get_event_loop().run_in_executor(None, func, *args)


def _is_git(path: str) -> bool:
    """True only when ``path`` is itself the top of a git worktree.

    Uses ``--show-toplevel`` rather than ``--is-inside-work-tree`` so a plain
    pack dir nested inside a larger git checkout (e.g. the whole ComfyUI tree)
    is NOT misreported as a git pack.
    """
    rc, out, _ = _git(["rev-parse", "--show-toplevel"], path)
    if rc != 0 or not out.strip():
        return False
    try:
        return os.path.realpath(out.strip()) == os.path.realpath(path)
    except OSError:
        return False


def _parse_ref(cwd: str) -> dict[str, Any]:
    """Resolve the current ref into {type, name, sha}.

    type is "branch" | "tag" | "detached". name is the branch/tag name (None
    when detached and not on a tag); sha is the full HEAD sha (or None).
    """
    rc, sha, _ = _git(["rev-parse", "HEAD"], cwd)
    head = sha.strip() if rc == 0 and sha.strip() else None

    rc, branch, _ = _git(["symbolic-ref", "--short", "-q", "HEAD"], cwd)
    if rc == 0 and branch.strip():
        return {"type": "branch", "name": branch.strip(), "sha": head}

    rc, tag, _ = _git(["describe", "--tags", "--exact-match"], cwd)
    if rc == 0 and tag.strip():
        return {"type": "tag", "name": tag.strip(), "sha": head}

    return {"type": "detached", "name": None, "sha": head}


def _remote_url(cwd: str, remote: str = "origin") -> str | None:
    """Return the configured URL for ``remote``, or None if it has none."""
    rc, out, _ = _git(["remote", "get-url", remote], cwd)
    return out.strip() if rc == 0 and out.strip() else None


def _is_dirty(cwd: str) -> bool:
    """True when the worktree has uncommitted changes (porcelain non-empty)."""
    rc, out, _ = _git(["status", "--porcelain"], cwd)
    return bool(out.strip()) if rc == 0 else False


def _ahead_behind(cwd: str) -> tuple[int, int, str | None]:
    """Return (ahead, behind, error) of HEAD vs its upstream tracking ref.

    No upstream configured is not an error — it yields (0, 0, None). A genuine
    git failure surfaces in the error slot so the caller can degrade per-pack.
    """
    rc, _, _ = _git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], cwd)
    if rc != 0:
        return 0, 0, None  # no tracking branch — nothing to compare against
    rc, out, err = _git(["rev-list", "--left-right", "--count", "HEAD...@{u}"], cwd)
    if rc != 0:
        return 0, 0, (err.strip() or "rev-list failed")
    parts = out.split()
    if len(parts) != 2:
        return 0, 0, "unparsable rev-list output"
    try:
        return int(parts[0]), int(parts[1]), None
    except ValueError:
        return 0, 0, "unparsable rev-list output"


def _behind_count(cwd: str, remote: str) -> int | None:
    """Commits HEAD is behind ``<remote>/<current-branch>``, or None.

    Compares against the already-fetched remote-tracking ref (does NOT fetch).
    None when the remote is absent, HEAD is detached, or the ref is missing.
    """
    if not _remote_url(cwd, remote):
        return None
    ref = _parse_ref(cwd)
    if ref["type"] != "branch" or not ref["name"]:
        return None
    rc, out, _ = _git(["rev-list", "--count", f"HEAD..{remote}/{ref['name']}"], cwd)
    if rc != 0:
        return None
    try:
        return int(out.strip())
    except ValueError:
        return None


def _ls_remote_refs(remote: str, kind: str, cwd: str) -> list[str]:
    """Return short branch ("--heads") or tag ("--tags") names from a remote."""
    rc, out, _ = _git(["ls-remote", kind, remote], cwd, timeout=30)
    if rc != 0:
        return []
    prefix = "refs/heads/" if kind == "--heads" else "refs/tags/"
    refs: list[str] = []
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) != 2:
            continue
        ref = parts[1]
        if ref.endswith("^{}"):  # peeled annotated-tag entry — skip the dup
            continue
        if ref.startswith(prefix):
            refs.append(ref[len(prefix) :])
    return refs


def _local_refs(cwd: str, namespace: str) -> list[str]:
    """Return short ref names under refs/<namespace> from the local repo."""
    rc, out, _ = _git(["for-each-ref", "--format=%(refname:short)", f"refs/{namespace}"], cwd)
    if rc != 0:
        return []
    return [line.strip() for line in out.splitlines() if line.strip()]


# ---------------------------------------------------------------------------
# Security / bind helpers (pure, unit-testable)
# ---------------------------------------------------------------------------


def _get_listen() -> str:
    """Read comfy.cli_args.args.listen defensively (tests stub the module)."""
    try:
        from comfy.cli_args import args

        return getattr(args, "listen", "") or ""
    except Exception:
        return ""


def _is_loopback(listen: str) -> bool:
    """True when the server is bound to a loopback address (or the default)."""
    return listen in _LOOPBACK


def _remote_install_allowed() -> bool:
    """True when the operator has opted into install on a non-loopback bind."""
    return os.environ.get("TOUCH_MANAGER_ALLOW_REMOTE_INSTALL") == "1"


def _remote_reboot_allowed() -> bool:
    """True when the operator has opted into reboot on a non-loopback bind."""
    return os.environ.get("TOUCH_MANAGER_ALLOW_REMOTE_REBOOT") == "1"


def _reboot_allowed() -> bool:
    """Reboot is allowed on a loopback bind, or with the remote opt-in.

    Mirrors the install gate: loopback is trusted by default; a non-loopback
    bind additionally requires TOUCH_MANAGER_ALLOW_REMOTE_REBOOT=1.
    """
    return _is_loopback(_get_listen()) or _remote_reboot_allowed()


def _sanitize_name(raw: str) -> str | None:
    """Return a safe directory name, or None if ``raw`` is unusable.

    Rejects "", ".", "..", anything with a path separator, and anything with a
    character outside [A-Za-z0-9._-].
    """
    if not raw or raw in {".", ".."}:
        return None
    if "/" in raw or "\\" in raw or os.sep in raw:
        return None
    if not _NAME_RE.match(raw):
        return None
    return raw


def _validate_url(url: Any) -> tuple[str | None, str | None]:
    """Validate a clone URL and derive its directory name.

    Returns (name, None) on success, or (None, "invalid_url") on any failure:
    not https, host not in ALLOWED_HOSTS, no owner/repo path, or a tail that
    does not sanitise to a safe directory name.
    """
    if not isinstance(url, str) or not url.startswith("https://"):
        return None, "invalid_url"
    rest = url[len("https://") :]
    host, _, path = rest.partition("/")
    if host not in ALLOWED_HOSTS:
        return None, "invalid_url"
    segments = [seg for seg in path.strip("/").split("/") if seg]
    if len(segments) < 2:  # need at least owner/repo
        return None, "invalid_url"
    tail = segments[-1]
    if tail.endswith(".git"):
        tail = tail[: -len(".git")]
    name = _sanitize_name(tail)
    if name is None:
        return None, "invalid_url"
    return name, None


def _within_root(target: str, root: str) -> bool:
    """Path-traversal guard: target must resolve strictly inside root."""
    return os.path.realpath(target).startswith(os.path.realpath(root) + os.sep)


def _safe_ref(ref: Any) -> str | None:
    """Return ``ref`` if it is safe to pass to ``git checkout``, else None.

    Guards against git argument injection: a ref beginning with ``-`` would be
    parsed by git as an OPTION rather than a ref (``-f``, ``-b``, ``--orphan``,
    ``--upload-pack=<cmd>``, …) — smuggling flags into checkout. Git itself
    forbids ref names starting with ``-``, so this rejects nothing legitimate.
    Non-strings and the empty string are also rejected.
    """
    if not isinstance(ref, str) or not ref or ref.startswith("-"):
        return None
    return ref


# ---------------------------------------------------------------------------
# folder_paths helpers
# ---------------------------------------------------------------------------


def _custom_nodes_roots() -> list[str]:
    """Every registered custom_nodes root (empty list on any failure)."""
    try:
        roots = folder_paths.get_folder_paths("custom_nodes")
    except Exception:
        return []
    return [r for r in roots if r]


def _core_dir() -> str:
    """The ComfyUI core repo directory."""
    base = getattr(folder_paths, "base_path", None)
    if base:
        return str(base)
    return os.path.dirname(folder_paths.__file__)


def _find_pack(name: str, *, include_disabled: bool = False) -> str | None:
    """Locate a pack dir by sanitised ``name`` across all custom_nodes roots."""
    safe = _sanitize_name(name)
    if not safe:
        return None
    for root in _custom_nodes_roots():
        cand = os.path.join(root, safe)
        if os.path.isdir(cand):
            return cand
        if include_disabled:
            disabled = cand + _DISABLED_SUFFIX
            if os.path.isdir(disabled):
                return disabled
    return None


# ---------------------------------------------------------------------------
# GitHub releases (best-effort, never blocks forever, [] on any failure)
# ---------------------------------------------------------------------------


def _github_owner_repo(remote: str | None) -> tuple[str, str] | None:
    """Parse a github remote URL into (owner, repo); None for non-github."""
    if not remote:
        return None
    https = re.match(r"^https://github\.com/([^/]+)/([^/]+?)(?:\.git)?/?$", remote)
    if https:
        return https.group(1), https.group(2)
    ssh = re.match(r"^git@github\.com:([^/]+)/([^/]+?)(?:\.git)?$", remote)
    if ssh:
        return ssh.group(1), ssh.group(2)
    return None


def _github_releases(remote: str | None) -> list[dict[str, Any]]:
    """Fetch GitHub releases for ``remote``; [] on non-github or any failure."""
    owner_repo = _github_owner_repo(remote)
    if not owner_repo:
        return []
    owner, repo = owner_repo
    url = f"https://api.github.com/repos/{owner}/{repo}/releases"
    req = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "comfyui-touch-manager",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = loads(resp.read().decode("utf-8"))
    except Exception as exc:
        log.debug("github releases fetch failed for %s: %s", remote, exc)
        return []
    if not isinstance(data, list):
        return []
    releases: list[dict[str, Any]] = []
    for entry in data:
        if not isinstance(entry, dict):
            continue
        releases.append(
            {
                "tag": entry.get("tag_name"),
                "name": entry.get("name"),
                "published_at": entry.get("published_at"),
                "prerelease": bool(entry.get("prerelease")),
            }
        )
    return releases


# ---------------------------------------------------------------------------
# Synchronous collectors (run off the event loop)
# ---------------------------------------------------------------------------


def _describe_pack(root: str, entry: str) -> dict[str, Any]:
    """Build the /installed record for one directory entry."""
    full = os.path.join(root, entry)
    enabled = not entry.endswith(_DISABLED_SUFFIX)
    name = entry if enabled else entry[: -len(_DISABLED_SUFFIX)]
    is_git = _is_git(full)
    if is_git:
        ref = _parse_ref(full)
        remote_url = _remote_url(full)
        dirty = _is_dirty(full)
    else:
        ref = {"type": "detached", "name": None, "sha": None}
        remote_url = None
        dirty = False
    return {
        "name": name,
        "path": full,
        "root": root,
        "is_git": is_git,
        "ref": ref,
        "remote_url": remote_url,
        "dirty": dirty,
        "enabled": enabled,
    }


def _iter_pack_dirs(root: str) -> list[str]:
    """Sorted directory entries under ``root``, skipping dot/dunder names."""
    try:
        entries = sorted(os.listdir(root))
    except OSError:
        return []
    out: list[str] = []
    for entry in entries:
        if entry.startswith(".") or entry.startswith("__"):
            continue
        if os.path.isdir(os.path.join(root, entry)):
            out.append(entry)
    return out


def _collect_installed() -> list[dict[str, Any]]:
    """Enumerate every pack dir across all custom_nodes roots."""
    packs: list[dict[str, Any]] = []
    for root in _custom_nodes_roots():
        for entry in _iter_pack_dirs(root):
            try:
                packs.append(_describe_pack(root, entry))
            except Exception:  # one bad pack must not drop the whole listing
                log.warning("failed describing pack %s/%s", root, entry, exc_info=True)
    return packs


def _collect_updates() -> list[dict[str, Any]]:
    """For each git pack: fetch, then report behind/ahead vs upstream."""
    out: list[dict[str, Any]] = []
    for root in _custom_nodes_roots():
        for entry in _iter_pack_dirs(root):
            full = os.path.join(root, entry)
            if not _is_git(full):
                continue
            name = entry[: -len(_DISABLED_SUFFIX)] if entry.endswith(_DISABLED_SUFFIX) else entry
            rc, _, err = _git(["fetch", "--quiet"], full, timeout=60)
            if rc != 0:
                out.append(
                    {
                        "name": name,
                        "update_available": False,
                        "behind": 0,
                        "ahead": 0,
                        "error": err.strip() or "fetch failed",
                    }
                )
                continue
            ahead, behind, err2 = _ahead_behind(full)
            out.append(
                {
                    "name": name,
                    "update_available": behind > 0,
                    "behind": behind,
                    "ahead": ahead,
                    "error": err2,
                }
            )
    return out


def _collect_versions(cwd: str, remote: str | None) -> tuple[list[str], list[str]]:
    """Return (branches, tags) from the remote when present, else local refs."""
    if remote:
        return (
            _ls_remote_refs(remote, "--heads", cwd),
            _ls_remote_refs(remote, "--tags", cwd),
        )
    return _local_refs(cwd, "heads"), _local_refs(cwd, "tags")


def _collect_core(cwd: str) -> dict[str, Any]:
    """Build the /core record for the ComfyUI core repo."""
    if not _is_git(cwd):
        return {
            "is_git": False,
            "ref": {"type": "detached", "name": None, "sha": None},
            "behind": {"origin": None, "upstream": None},
            "dirty": False,
            "remotes": {"origin": None, "upstream": None},
        }
    return {
        "is_git": True,
        "ref": _parse_ref(cwd),
        "behind": {
            "origin": _behind_count(cwd, "origin"),
            "upstream": _behind_count(cwd, "upstream"),
        },
        "dirty": _is_dirty(cwd),
        "remotes": {
            "origin": _remote_url(cwd, "origin"),
            "upstream": _remote_url(cwd, "upstream"),
        },
    }


def _do_core_pull(cwd: str) -> tuple[int, bool, str]:
    """git pull --ff-only core; report whether requirements.txt changed."""
    rc, before, _ = _git(["rev-parse", "HEAD"], cwd)
    if rc != 0:
        return rc, False, "not a git repo"
    rc, _, err = _git(["pull", "--ff-only"], cwd, timeout=120)
    if rc != 0:
        return rc, False, err.strip() or "pull failed"
    rc, after, _ = _git(["rev-parse", "HEAD"], cwd)
    deps_changed = False
    if rc == 0 and before.strip() != after.strip():
        rc, names, _ = _git(["diff", "--name-only", before.strip(), after.strip()], cwd)
        if rc == 0:
            deps_changed = any(
                line.strip().endswith("requirements.txt") for line in names.splitlines()
            )
    return 0, deps_changed, ""


# ---------------------------------------------------------------------------
# Response helpers
# ---------------------------------------------------------------------------


def _err(message: str, code: str, status: int) -> web.Response:
    """The shared error envelope: {"ok": false, "error", "code"} + status."""
    return web.json_response({"ok": False, "error": message, "code": code}, status=status)


async def _body(request: web.Request) -> dict[str, Any]:
    """Parse the JSON request body, degrading to {} on anything malformed."""
    try:
        data = await request.json()
    except (JSONDecodeError, ValueError, TypeError):
        return {}
    return data if isinstance(data, dict) else {}


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@PromptServer.instance.routes.get("/touch_manager/config")
async def config(request: web.Request) -> web.Response:
    """Report the bind/security gates the frontend reflects in its UI."""
    listen = _get_listen()
    return web.json_response(
        {
            "ok": True,
            "allow_remote_install": _remote_install_allowed(),
            "is_loopback": _is_loopback(listen),
            "manager_enabled": True,
            "reboot_allowed": _reboot_allowed(),
        }
    )


@PromptServer.instance.routes.get("/touch_manager/installed")
async def installed(request: web.Request) -> web.Response:
    """List every pack dir across all custom_nodes roots."""
    packs = await _run(_collect_installed)
    return web.json_response({"ok": True, "packs": packs})


@PromptServer.instance.routes.get("/touch_manager/updates")
async def updates(request: web.Request) -> web.Response:
    """Per-pack update availability (fetches each git pack; degrades per-pack)."""
    packs = await _run(_collect_updates)
    return web.json_response({"ok": True, "packs": packs})


@PromptServer.instance.routes.get("/touch_manager/versions")
async def versions(request: web.Request) -> web.Response:
    """List branches/tags (and GitHub releases) available for one pack."""
    name = request.rel_url.query.get("name", "")
    safe = _sanitize_name(name)
    if not safe:
        return _err("missing or invalid name", "not_found", 400)
    full = _find_pack(safe, include_disabled=True)
    if not full or not _is_git(full):
        return _err("not found", "not_found", 404)
    remote = await _run(_remote_url, full)
    branches, tags = await _run(_collect_versions, full, remote)
    releases = await _run(_github_releases, remote) if remote else []
    return web.json_response(
        {
            "ok": True,
            "name": safe,
            "branches": branches,
            "tags": tags,
            "releases": releases,
        }
    )


@PromptServer.instance.routes.post("/touch_manager/install")
async def install(request: web.Request) -> web.Response:
    """Clone an allowlisted github/gitlab URL into the first custom_nodes root."""
    body = await _body(request)
    # Bind gate FIRST — never reach validation/clone on a non-loopback bind
    # unless the operator explicitly opted in.
    if not _is_loopback(_get_listen()) and not _remote_install_allowed():
        return _err("install disabled on non-loopback bind", "blocked_remote_bind", 403)

    name, code = _validate_url(body.get("url"))
    if code or name is None:
        return _err("invalid repository url", "invalid_url", 400)

    # Validate any explicit ref BEFORE the (expensive) clone so a malicious ref
    # can never reach git, and we don't leave a half-cloned dir behind.
    ref = body.get("ref")
    safe_ref = _safe_ref(ref) if ref else None
    if ref and safe_ref is None:
        return _err("invalid ref", "checkout_failed", 400)

    roots = _custom_nodes_roots()
    if not roots:
        return _err("no custom_nodes root available", "clone_failed", 500)
    root = roots[0]
    target = os.path.join(root, name)
    if not _within_root(target, root):
        return _err("invalid repository url", "invalid_url", 400)
    if os.path.exists(target) or os.path.exists(target + _DISABLED_SUFFIX):
        return _err(f"{name} already installed", "exists", 409)

    url = body.get("url")
    rc, _, err = await _run(_git, ["clone", url, target], root, 300)
    if rc != 0:
        return _err(err.strip() or "clone failed", "clone_failed", 500)

    if safe_ref:
        rc, _, err = await _run(_git, ["checkout", safe_ref], target, 120)
        if rc != 0:
            return _err(err.strip() or "checkout failed", "checkout_failed", 500)

    return web.json_response({"ok": True, "name": name, "restart_required": True})


@PromptServer.instance.routes.post("/touch_manager/update")
async def update(request: web.Request) -> web.Response:
    """Fetch then checkout/fast-forward one pack to ``ref`` (or its upstream)."""
    body = await _body(request)
    name = _sanitize_name(str(body.get("name", "")))
    if not name:
        return _err("not found", "not_found", 404)
    full = _find_pack(name)
    if not full:
        return _err("not found", "not_found", 404)
    if not _is_git(full):
        return _err("not a git repository", "not_git", 400)

    # Validate any explicit ref BEFORE fetching so a malicious ref never reaches
    # git (argument-injection guard — see _safe_ref).
    ref = body.get("ref")
    safe_ref = _safe_ref(ref) if ref else None
    if ref and safe_ref is None:
        return _err("invalid ref", "checkout_failed", 400)

    rc, _, err = await _run(_git, ["fetch", "--all", "--tags"], full, 120)
    if rc != 0:
        return _err(err.strip() or "fetch failed", "fetch_failed", 500)

    if safe_ref:
        rc, _, err = await _run(_git, ["checkout", safe_ref], full, 60)
    else:
        rc, _, err = await _run(_git, ["merge", "--ff-only", "@{u}"], full, 60)
    if rc != 0:
        return _err(err.strip() or "checkout failed", "checkout_failed", 500)

    return web.json_response({"ok": True, "name": name, "restart_required": True})


@PromptServer.instance.routes.post("/touch_manager/uninstall")
async def uninstall(request: web.Request) -> web.Response:
    """Disable a pack reversibly by renaming its dir to ``<name>.disabled``."""
    body = await _body(request)
    name = _sanitize_name(str(body.get("name", "")))
    if not name:
        return _err("not found", "not_found", 404)
    full = _find_pack(name)
    if not full:
        return _err("not found", "not_found", 404)

    disabled = full + _DISABLED_SUFFIX
    try:
        os.rename(full, disabled)
    except OSError as exc:
        return _err(str(exc), "not_found", 500)

    return web.json_response({"ok": True, "name": name, "restart_required": True})


@PromptServer.instance.routes.get("/touch_manager/core")
async def core(request: web.Request) -> web.Response:
    """Report the core repo's ref, behind counts, dirtiness, and remotes."""
    info = await _run(_collect_core, _core_dir())
    return web.json_response({"ok": True, **info})


@PromptServer.instance.routes.post("/touch_manager/core/update")
async def core_update(request: web.Request) -> web.Response:
    """git pull the core repo; report whether requirements.txt changed.

    Does NOT pip-install and does NOT restart — both are user actions.
    """
    cwd = _core_dir()
    if not await _run(_is_git, cwd):
        return _err("core is not a git repository", "not_git", 400)
    rc, deps_changed, err = await _run(_do_core_pull, cwd)
    if rc != 0:
        return _err(err or "pull failed", "pull_failed", 500)
    return web.json_response({"ok": True, "deps_changed": deps_changed, "restart_required": True})


@PromptServer.instance.routes.post("/touch_manager/reboot")
async def reboot(request: web.Request) -> web.Response:
    """Restart the server via os.execv.

    Allowed on a loopback bind by default; a non-loopback bind additionally
    requires TOUCH_MANAGER_ALLOW_REMOTE_REBOOT=1 (see _reboot_allowed). Refuses
    with 403 otherwise.
    """
    if not _reboot_allowed():
        return _err("reboot disabled", "reboot_disabled", 403)
    # Replace the current process image with a fresh interpreter on the same
    # argv. Tests monkeypatch os.execv so the gate can be exercised without
    # actually replacing the process.
    os.execv(sys.executable, [sys.executable, *sys.argv])
    return web.json_response({"ok": True, "restart_required": True})  # pragma: no cover


class TouchNodeManager:
    """Marker node so the pack registers as a custom-node module.

    The pack is an interaction enhancer — the real work is the frontend modal
    plus the /touch_manager/* endpoints above. This node has no inputs or
    outputs; it exists only so ComfyUI imports the module (and thus registers
    the routes). It lives in its own category to stay out of the add-node UI.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ()
    FUNCTION = "run"
    CATEGORY = "Touch Node Manager"

    def run(self):
        return ()


NODE_CLASS_MAPPINGS = {"TouchNodeManager": TouchNodeManager}
NODE_DISPLAY_NAME_MAPPINGS = {"TouchNodeManager": "Touch Node Manager"}
