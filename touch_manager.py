"""Touch Node Manager — backend node + HTTP endpoints.

A touch-first node/extension manager for ComfyUI. The backend performs
self-contained git operations (enumerate installed packs, check for updates,
install from a URL, switch versions, update core) behind a small JSON HTTP
surface the frontend modal drives. After a git operation lands new/changed code
it installs that code's Python dependencies (requirements.txt / pyproject.toml)
so the pack is not left half-installed — but it restarts NOTHING: every mutating
route sets ``restart_required: true`` and leaves the restart to the user.

Uses ComfyUI-bundled libraries ONLY (aiohttp, plus folder_paths / server from
ComfyUI core) and the Python standard library (subprocess, os, asyncio, json,
re, urllib, tomllib). Dependency installation shells out to the running
interpreter's own pip (``python -m pip``); no third-party lib is required —
``tomli`` is used as a TOML reader on Python 3.10 only if it happens to be
importable already.

Route surface (all under /touch_manager/, all return {"ok": bool, ...}; errors
are {"ok": false, "error": <msg>, "code": <slug>} with a matching HTTP status):

  GET  /touch_manager/config      — bind/security gates the frontend reflects
  GET  /touch_manager/installed   — every pack dir across all custom_nodes roots
  GET  /touch_manager/updates     — per-pack behind/ahead vs upstream (fetches)
  GET  /touch_manager/versions    — branches/tags/releases for one pack
  GET  /touch_manager/forks       — a pack's upstream + fork siblings (GitHub)
  POST /touch_manager/install     — clone a github/gitlab URL into roots[0]
  POST /touch_manager/update      — fetch + checkout/ff one pack, install deps
                                    (``force`` discards local changes on a dirty tree)
  POST /touch_manager/remote      — repoint one pack at a different fork and
                                    check it out (``force`` on a dirty tree)
  POST /touch_manager/uninstall   — reversible disable (rename to .disabled)
  POST /touch_manager/enable      — re-enable a disabled pack (drop .disabled)
  POST /touch_manager/delete      — IRREVERSIBLE removal of a pack directory
  GET  /touch_manager/core        — core repo ref/behind/dirty/remotes
  POST /touch_manager/core/update — git pull core; install deps on drift
  POST /touch_manager/reboot      — opt-in os.execv stub (disabled by default)

Security perimeter (enforced here, surfaced in the frontend via /config):
  - Bind gate: /install and /remote are refused on a NON-loopback bind unless
    the operator sets TOUCH_MANAGER_ALLOW_REMOTE_INSTALL=1 — both land code
    from an arbitrary allowlisted repository. /delete is gated separately
    (loopback, or TOUCH_MANAGER_ALLOW_REMOTE_DELETE=1) since it destroys data.
  - URL allowlist: https github.com / gitlab.com only; the derived directory
    name is sanitised to [A-Za-z0-9._-] and path-traversal-guarded against the
    install root.
  - git is always invoked with an argument LIST (never shell=True), with a
    timeout and an explicit cwd. No caller string is interpolated into a shell.
"""

from __future__ import annotations

import asyncio
import contextlib
import io
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from json import JSONDecodeError, loads
from typing import Any
from urllib.parse import urlencode, urlparse

# TOML reader. `tomllib` is stdlib on 3.11+; on an older host we fall back to
# `tomli` (same API, and the module tomllib was derived from) *only if it is
# already importable* — this adds no dependency, it just stops a 3.10 host from
# losing every pyproject-derived feature when a perfectly good reader is
# already installed as somebody else's transitive dep. Measured on a 3.10
# ComfyUI: without the fallback all 18 non-git packs reported source "unknown"
# and were silently excluded from registry update checks.
try:  # stdlib on Python 3.11+
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - depends on interpreter version
    try:
        import tomli as tomllib  # type: ignore[no-redef]
    except ModuleNotFoundError:
        tomllib = None  # type: ignore[assignment]

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

# Cap the per-update commit log so the response stays bounded on a pack that
# fast-forwards over a large history.
_UPDATE_LOG_CAP = 20

# Comfy Registry (https://registry.comfy.org). Search + install metadata come
# from its public REST API; the actual node archive is a zip hosted off-forge.
REGISTRY_API = "https://api.comfy.org"
REGISTRY_PAGE_SIZE = 24

# Hosts a registry archive (downloadUrl) may come from. Tight + https-only: the
# registry CDN (cdn.comfy.org) it now serves published archives from, the API
# itself, and the GCS bucket the CDN fronts. Anything else is refused and logged
# so the operator can extend this deliberately.
ARCHIVE_ALLOWED_HOSTS = {
    "cdn.comfy.org",
    "api.comfy.org",
    "storage.googleapis.com",
    "storage.cloud.google.com",
}

# Hard ceiling on a downloaded archive, so a hostile/garbage URL cannot exhaust
# disk. 250 MB comfortably covers real node packs.
MAX_ARCHIVE_BYTES = 250 * 1024 * 1024

# GitHub REST API — releases (version picker) and forks (fork picker). Read-only
# and unauthenticated: everything sourced from it is best-effort.
GITHUB_API = "https://api.github.com"

# Cap the fork listing. Popular packs have hundreds of forks, nearly all stale;
# the API sorts by stars so the first page is the part worth showing on a phone.
_FORKS_PER_PAGE = 30


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


def _remote_delete_allowed() -> bool:
    """True when the operator has opted into delete on a non-loopback bind."""
    return os.environ.get("TOUCH_MANAGER_ALLOW_REMOTE_DELETE") == "1"


def _delete_allowed() -> bool:
    """Permanent delete is allowed on a loopback bind, or with the remote opt-in.

    Deletion is the one IRREVERSIBLE operation here — ``uninstall`` merely
    renames a pack aside, but ``delete`` unlinks it. It therefore gets its own
    gate (shaped like the reboot one) rather than riding on the install gate: an
    operator who exposed the manager to their LAN to install packs has not
    thereby consented to anyone on it wiping their custom_nodes tree.
    """
    return _is_loopback(_get_listen()) or _remote_delete_allowed()


def _install_allowed() -> bool:
    """True when this bind may land new code (clone / fork switch).

    Loopback is trusted by default; a non-loopback bind requires
    TOUCH_MANAGER_ALLOW_REMOTE_INSTALL=1.
    """
    return _is_loopback(_get_listen()) or _remote_install_allowed()


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


def _safe_version(version: Any) -> str | None:
    """Return a registry version string safe to put in an API path, else None.

    Rejects non-strings, the empty string, leading "-", path separators and
    "..", and anything outside the semver-ish alphabet.
    """
    if not isinstance(version, str) or not version or version.startswith("-"):
        return None
    if "/" in version or "\\" in version or ".." in version:
        return None
    if not re.match(r"^[A-Za-z0-9._+-]+$", version):
        return None
    return version


def _validate_archive_url(url: Any) -> bool:
    """True only for an https URL whose host is in ARCHIVE_ALLOWED_HOSTS."""
    if not isinstance(url, str):
        return False
    parsed = urlparse(url)
    if parsed.scheme != "https":
        return False
    host = (parsed.hostname or "").lower()
    if host not in ARCHIVE_ALLOWED_HOSTS:
        log.debug("rejected archive host %r (not in allowlist)", host)
        return False
    return True


def _coerce_page(raw: Any) -> int:
    """Parse a 1-based page number, clamping junk/<1 to 1."""
    try:
        n = int(str(raw))
    except (ValueError, TypeError):
        return 1
    return n if n >= 1 else 1


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


_REMOTE_OWNER_RE = re.compile(
    r"^(?:https://(?:github|gitlab)\.com/|git@(?:github|gitlab)\.com:)([^/]+)/"
)


def _owner_from_remote(remote: str | None) -> str | None:
    """Best-effort owner/org parsed from a github.com or gitlab.com remote URL."""
    if not remote:
        return None
    m = _REMOTE_OWNER_RE.match(remote)
    return m.group(1) if m else None


def _pyproject_publisher(path: str) -> str | None:
    """Return ``[tool.comfy].PublisherId`` from a pyproject.toml, or None."""
    if tomllib is None:
        return None
    try:
        with open(path, "rb") as fh:
            data = tomllib.load(fh)
    except (OSError, tomllib.TOMLDecodeError):
        return None
    tool = data.get("tool")
    comfy = tool.get("comfy") if isinstance(tool, dict) else None
    publisher = comfy.get("PublisherId") if isinstance(comfy, dict) else None
    return publisher if isinstance(publisher, str) and publisher.strip() else None


def _pack_author(full: str, remote_url: str | None) -> str:
    """The pack's author for display/filtering.

    A git remote's owner (github.com/gitlab.com) wins when present; otherwise
    fall back to the registry PublisherId in pyproject.toml (set for packs
    installed from the Comfy Registry, which are not git checkouts). "" when
    neither source resolves.
    """
    owner = _owner_from_remote(remote_url)
    if owner:
        return owner
    publisher = _pyproject_publisher(os.path.join(full, "pyproject.toml"))
    return publisher or ""


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


def _github_get(path: str, params: dict[str, Any] | None = None) -> Any | None:
    """GET an api.github.com endpoint and decode JSON; None on any failure.

    Unauthenticated and best-effort (same shape as ``_registry_get``): a rate
    limit, a private repo, or no network degrades to None so the caller can fall
    back rather than fail the whole request.
    """
    url = GITHUB_API + path
    if params:
        url += "?" + urlencode(params)
    req = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "comfyui-touch-manager",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            return loads(resp.read().decode("utf-8"))
    except Exception as exc:
        log.debug("github GET failed for %s: %s", url, exc)
        return None


def _github_releases(remote: str | None) -> list[dict[str, Any]]:
    """Fetch GitHub releases for ``remote``; [] on non-github or any failure."""
    owner_repo = _github_owner_repo(remote)
    if not owner_repo:
        return []
    owner, repo = owner_repo
    data = _github_get(f"/repos/{owner}/{repo}/releases")
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


def _normalize_github_repo(raw: Any) -> dict[str, Any] | None:
    """Trim a GitHub repo object to the fields the fork picker renders.

    Returns None when the entry is unusable — notably when its derived
    ``https://github.com/<owner>/<repo>`` URL would NOT pass the install
    allowlist, so the picker can never offer a repo the switch route would then
    refuse.
    """
    if not isinstance(raw, dict):
        return None
    full_name = raw.get("full_name")
    if not isinstance(full_name, str) or full_name.count("/") != 1:
        return None
    # Both halves must survive the same name guard the install path applies —
    # _validate_url only sanitises the repo tail, and an owner it would let
    # through unchecked has no business being built into a clone URL.
    if any(_sanitize_name(seg) is None for seg in full_name.split("/")):
        return None
    url = f"https://github.com/{full_name}"
    if _validate_url(url)[1]:
        return None
    owner = raw.get("owner")
    login = owner.get("login") if isinstance(owner, dict) else None
    return {
        "full_name": full_name,
        "owner": login or full_name.split("/", 1)[0],
        "url": url,
        "description": raw.get("description") or "",
        "stars": raw.get("stargazers_count") or 0,
        "pushed_at": raw.get("pushed_at"),
        "archived": bool(raw.get("archived")),
    }


def _collect_forks(remote: str | None) -> dict[str, Any]:
    """Upstream + fork siblings of the repo ``remote`` points at.

    ``parent`` is the repo this one was forked from and ``source`` the ultimate
    root of the fork network (both None when ``remote`` is not itself a fork);
    ``forks`` lists the fork network's members. Siblings are listed from the
    ROOT repo, not from ``remote`` — a fork's own /forks is nearly always empty,
    while the root's is the list a user actually wants to switch between.

    Everything is best-effort: a non-GitHub remote (gitlab, ssh, none) or any
    API failure yields empty fields, and the frontend falls back to its
    paste-a-URL entry.
    """
    empty: dict[str, Any] = {"parent": None, "source": None, "forks": []}
    owner_repo = _github_owner_repo(remote)
    if not owner_repo:
        return empty
    owner, repo = owner_repo

    info = _github_get(f"/repos/{owner}/{repo}")
    parent = _normalize_github_repo(info.get("parent")) if isinstance(info, dict) else None
    source = _normalize_github_repo(info.get("source")) if isinstance(info, dict) else None
    if source and parent and source["full_name"] == parent["full_name"]:
        source = None  # a one-level fork: parent IS the source, don't list it twice

    root = source or parent
    list_owner, list_repo = root["full_name"].split("/", 1) if root else (owner, repo)
    data = _github_get(
        f"/repos/{list_owner}/{list_repo}/forks",
        {"sort": "stargazers", "per_page": _FORKS_PER_PAGE},
    )
    forks: list[dict[str, Any]] = []
    if isinstance(data, list):
        for entry in data:
            norm = _normalize_github_repo(entry)
            if norm:
                forks.append(norm)
    return {"parent": parent, "source": source, "forks": forks}


# ---------------------------------------------------------------------------
# Comfy Registry (best-effort GET; None on any failure)
# ---------------------------------------------------------------------------


def _registry_get(path: str, params: dict[str, Any] | None = None) -> Any | None:
    """GET a Comfy Registry endpoint and decode JSON; None on any failure."""
    url = REGISTRY_API + path
    if params:
        clean = {k: v for k, v in params.items() if v not in (None, "")}
        if clean:
            url += "?" + urlencode(clean)
    req = urllib.request.Request(
        url,
        headers={"Accept": "application/json", "User-Agent": "comfyui-touch-manager"},
    )
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            return loads(resp.read().decode("utf-8"))
    except Exception as exc:
        log.debug("registry GET failed for %s: %s", url, exc)
        return None


def _normalize_registry_node(raw: dict[str, Any]) -> dict[str, Any]:
    """Trim a registry node object down to the fields the UI renders."""
    pub = raw.get("publisher")
    if isinstance(pub, dict):
        publisher = pub.get("name") or pub.get("id")
    elif isinstance(pub, str):
        publisher = pub
    else:
        publisher = None
    latest = raw.get("latest_version")
    version = latest.get("version") if isinstance(latest, dict) else None
    return {
        "id": raw.get("id"),
        "name": raw.get("name") or raw.get("id"),
        "description": raw.get("description") or "",
        "author": raw.get("author") or publisher or "",
        "downloads": raw.get("downloads") or 0,
        "icon": raw.get("icon") or "",
        "repository": raw.get("repository") or "",
        "latest_version": version,
        "publisher": publisher,
    }


def _fetch_bytes(url: str, cap: int) -> bytes:
    """Download up to ``cap`` bytes from ``url``; raise if it exceeds the cap.

    Isolated so tests can monkeypatch it to return local archive bytes without
    any network. Reads cap+1 so an over-cap body is detected, not truncated.
    """
    req = urllib.request.Request(url, headers={"User-Agent": "comfyui-touch-manager"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = resp.read(cap + 1)
    if len(data) > cap:
        raise ValueError("archive exceeds size cap")
    return data


def _zip_members_safe(zf: zipfile.ZipFile) -> bool:
    """True only when every member extracts inside the target (no zip-slip)."""
    for name in zf.namelist():
        if name.startswith(("/", "\\")) or os.path.isabs(name):
            return False
        norm = os.path.normpath(name)
        if norm == ".." or norm.startswith(".." + os.sep):
            return False
    return True


def _do_registry_install(
    download_url: str, name: str, root: str
) -> tuple[dict[str, Any] | None, str, str]:
    """Download + safely extract a registry archive into ``root/<name>``.

    Returns (result, "", "") on success or (None, error, code) on failure.
    Extraction is staged in a temp dir inside ``root`` (so the final move is an
    atomic same-filesystem rename) and guarded against zip-slip. A single
    wrapper directory (GitHub-style archives) is unwrapped. Nothing is left in
    custom_nodes on any failure.
    """
    target = os.path.join(root, name)
    if not _within_root(target, root):
        return None, "invalid target", "invalid_id"
    if os.path.exists(target) or os.path.exists(target + _DISABLED_SUFFIX):
        return None, f"{name} already installed", "exists"

    try:
        data = _fetch_bytes(download_url, MAX_ARCHIVE_BYTES)
    except Exception as exc:
        return None, str(exc) or "download failed", "download_failed"

    # Dot-prefixed so a half-extracted stage is skipped by the installed listing.
    stage: str | None = tempfile.mkdtemp(prefix=".tm-reg-", dir=root)
    try:
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as zf:
                if not _zip_members_safe(zf):
                    return None, "unsafe archive member", "extract_failed"
                zf.extractall(stage)
        except zipfile.BadZipFile:
            return None, "bad zip archive", "extract_failed"

        entries = os.listdir(stage)
        if len(entries) == 1 and os.path.isdir(os.path.join(stage, entries[0])):
            pack_root = os.path.join(stage, entries[0])  # unwrap single dir
        else:
            pack_root = stage
        deps_changed = os.path.isfile(os.path.join(pack_root, "requirements.txt"))

        os.rename(pack_root, target)
        if pack_root == stage:
            stage = None  # the stage dir itself became the target
        return {"deps_changed": deps_changed}, "", ""
    finally:
        if stage and os.path.isdir(stage):
            shutil.rmtree(stage, ignore_errors=True)


# ---------------------------------------------------------------------------
# Dependency installation (pip against the running interpreter)
# ---------------------------------------------------------------------------
#
# A git update that lands a new requirements.txt / pyproject.toml but does NOT
# install it leaves ComfyUI in a broken state: the pack's Python imports fail on
# the next start. So every route that lands new code follows the git operation
# with a dependency install into the SAME interpreter running ComfyUI
# (``sys.executable -m pip``). This is blocking work — always call via ``_run``.

# Cap captured pip output so a chatty install can't bloat the JSON response.
_DEPS_LOG_TAIL = 4000

# Filenames that, when present/changed, mean a pack's Python deps need (re)install.
_DEPS_FILES = ("requirements.txt", "pyproject.toml")


def _tail(text: str, cap: int) -> str:
    """Return the last ``cap`` characters of ``text`` (whole string if shorter)."""
    text = text.strip()
    if len(text) <= cap:
        return text
    return "…" + text[-cap:]


def _no_deps() -> dict[str, Any]:
    """The 'nothing installed' deps record, shared by every non-attempt path."""
    return {"attempted": False, "ok": None, "sources": [], "error": None, "log": ""}


def _pip_install(args: list[str], cwd: str, timeout: int = 300) -> tuple[int, str]:
    """Run ``python -m pip install <args>`` in ``cwd``; return (rc, output).

    Mirrors ``_git``: never raises (timeout -> 124, missing binary -> 127), always
    an argument LIST (never shell=True). Isolated so tests monkeypatch it instead
    of shelling out to real pip. ``--no-input`` keeps pip from ever blocking on a
    prompt inside the executor thread.
    """
    try:
        proc = subprocess.run(
            [sys.executable, "-m", "pip", "install", "--no-input", *args],
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return 124, "pip timed out"
    except OSError as exc:
        return 127, str(exc)
    return proc.returncode, (proc.stdout or "") + (proc.stderr or "")


def _pyproject_deps(path: str) -> list[str]:
    """Return the ``[project.dependencies]`` specifiers from a pyproject.toml.

    Empty list when no TOML reader is importable (Python < 3.11 without
    ``tomli``), the file is
    unparsable, or there is no ``[project] dependencies`` array. Only runtime
    dependencies are returned — build-system and optional-dependency groups are
    intentionally ignored.
    """
    if tomllib is None:
        return []
    try:
        with open(path, "rb") as fh:
            data = tomllib.load(fh)
    except (OSError, tomllib.TOMLDecodeError):
        return []
    project = data.get("project")
    if not isinstance(project, dict):
        return []
    deps = project.get("dependencies")
    if not isinstance(deps, list):
        return []
    return [d for d in deps if isinstance(d, str) and d.strip()]


def _pyproject_project_meta(path: str) -> dict[str, str | None]:
    """Return ``{"name", "version"}`` from a pyproject.toml's ``[project]`` table.

    Both None when no TOML reader is importable (Python < 3.11 without
    ``tomli``), the file is unparsable, or the fields are absent/blank.
    """
    empty: dict[str, str | None] = {"name": None, "version": None}
    if tomllib is None:
        return empty
    try:
        with open(path, "rb") as fh:
            data = tomllib.load(fh)
    except (OSError, tomllib.TOMLDecodeError):
        return empty
    project = data.get("project")
    if not isinstance(project, dict):
        return empty
    name = project.get("name")
    version = project.get("version")
    return {
        "name": name if isinstance(name, str) and name.strip() else None,
        "version": version if isinstance(version, str) and version.strip() else None,
    }


def _registry_source_meta(full: str) -> dict[str, str] | None:
    """Registry ``{id, version}`` for a non-git pack with a Comfy Registry pyproject.

    ``id`` is the package's ``[project.name]`` — the slug the registry
    publishes under — and ``version`` its ``[project.version]``. None when
    either is missing/unparsable, meaning the pack is a plain, unmanaged
    directory this manager cannot check for registry updates.
    """
    pyproject = os.path.join(full, "pyproject.toml")
    if not os.path.isfile(pyproject):
        return None
    meta = _pyproject_project_meta(pyproject)
    name, version = meta["name"], meta["version"]
    if not name or not version:
        return None
    return {"id": name, "version": version}


def _install_deps(pack_dir: str, timeout: int = 300) -> dict[str, Any]:
    """Install a pack's Python dependencies from requirements.txt / pyproject.toml.

    Returns {attempted, ok, sources, error, log}; never raises. requirements.txt
    and pyproject's ``[project.dependencies]`` are installed in separate pip
    invocations so one failing source does not mask the other, and ``ok`` is the
    AND of every attempt. When neither source is present nothing runs and the
    'not attempted' record is returned.
    """
    result = _no_deps()
    logs: list[str] = []
    errors: list[str] = []
    ok = True

    req = os.path.join(pack_dir, "requirements.txt")
    if os.path.isfile(req):
        result["attempted"] = True
        result["sources"].append("requirements.txt")
        rc, out = _pip_install(["-r", req], pack_dir, timeout)
        logs.append(out)
        if rc != 0:
            ok = False
            errors.append(f"requirements.txt: pip exited {rc}")

    pyproject = os.path.join(pack_dir, "pyproject.toml")
    specs = _pyproject_deps(pyproject) if os.path.isfile(pyproject) else []
    if specs:
        result["attempted"] = True
        result["sources"].append("pyproject.toml")
        # ``--`` stops pip option parsing so a spec beginning with "-" cannot
        # smuggle a flag (mirrors the _safe_ref argument-injection guard).
        rc, out = _pip_install(["--", *specs], pack_dir, timeout)
        logs.append(out)
        if rc != 0:
            ok = False
            errors.append(f"pyproject.toml: pip exited {rc}")

    if result["attempted"]:
        result["ok"] = ok
        result["error"] = "; ".join(errors) or None
        result["log"] = _tail("\n".join(logs), _DEPS_LOG_TAIL)
    return result


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
    registry = None if is_git else _registry_source_meta(full)
    return {
        "name": name,
        "path": full,
        "root": root,
        "is_git": is_git,
        "ref": ref,
        "remote_url": remote_url,
        "dirty": dirty,
        "enabled": enabled,
        "author": _pack_author(full, remote_url),
        "source": "git" if is_git else ("registry" if registry else "unknown"),
        "registry_id": registry["id"] if registry else None,
        "installed_version": registry["version"] if registry else None,
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


def _list_updatable_packs() -> list[dict[str, Any]]:
    """Names of every pack across roots this manager can check for updates.

    Two kinds: git packs (fetch-based check) and registry-installed packs with
    a resolvable ``[project]`` name/version in pyproject.toml
    (registry-version-based check). No fetch here — for fast listing. Lets the
    frontend paint the update-check skeleton instantly and then check each
    pack one at a time, streaming results in.
    """
    out: list[dict[str, Any]] = []
    for root in _custom_nodes_roots():
        for entry in _iter_pack_dirs(root):
            # Skip disabled packs: updates/check resolves names via _find_pack
            # (without include_disabled), so listing a ".disabled" pack here only
            # produces a phantom row that errors "not found" on check.
            if entry.endswith(_DISABLED_SUFFIX):
                continue
            full = os.path.join(root, entry)
            if _is_git(full) or _registry_source_meta(full):
                out.append({"name": entry})
    return out


def _check_one_update(full: str, name: str) -> dict[str, Any]:
    """Fetch ONE git pack and report behind/ahead plus a short incoming commit log.

    Same per-pack shape as _collect_updates, with an extra ``incoming`` preview
    so the UI can show what an update would bring. Degrades per-pack: a fetch
    failure surfaces in ``error`` rather than raising.
    """
    rc, _, err = _git(["fetch", "--quiet"], full, timeout=60)
    if rc != 0:
        return {
            "name": name,
            "source": "git",
            "update_available": False,
            "behind": 0,
            "ahead": 0,
            "error": err.strip() or "fetch failed",
            "incoming": [],
            "latest_version": None,
        }
    ahead, behind, err2 = _ahead_behind(full)
    incoming: list[dict[str, str]] = []
    if behind > 0:
        rc, logout, _ = _git(["log", "-n5", "--pretty=format:%h\t%s", "HEAD..@{u}"], full)
        if rc == 0:
            for line in logout.splitlines():
                sha, _, subject = line.partition("\t")
                if sha:
                    incoming.append({"sha": sha, "subject": subject})
    return {
        "name": name,
        "source": "git",
        "update_available": behind > 0,
        "behind": behind,
        "ahead": ahead,
        "error": err2,
        "incoming": incoming,
        "latest_version": None,
    }


def _check_one_registry_update(node_id: str, current_version: str, name: str) -> dict[str, Any]:
    """Compare an installed registry pack's version against the registry's latest.

    Same per-pack shape as _check_one_update so the frontend sweep can treat
    both kinds uniformly. Degrades to an ``error`` entry on any registry
    failure rather than raising.
    """
    node = _registry_get(f"/nodes/{node_id}")
    if not isinstance(node, dict):
        return {
            "name": name,
            "source": "registry",
            "update_available": False,
            "behind": 0,
            "ahead": 0,
            "error": "registry unavailable",
            "incoming": [],
            "latest_version": None,
        }
    latest = node.get("latest_version")
    latest_version = latest.get("version") if isinstance(latest, dict) else None
    if not latest_version:
        return {
            "name": name,
            "source": "registry",
            "update_available": False,
            "behind": 0,
            "ahead": 0,
            "error": "no published version",
            "incoming": [],
            "latest_version": None,
        }
    update_available = latest_version != current_version
    return {
        "name": name,
        "source": "registry",
        "update_available": update_available,
        "behind": 1 if update_available else 0,
        "ahead": 0,
        "error": None,
        "incoming": [{"sha": "", "subject": f"v{latest_version} available"}]
        if update_available
        else [],
        "latest_version": latest_version,
    }


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
    """git pull --ff-only core; report whether a dependency file changed."""
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
                os.path.basename(line.strip()) in _DEPS_FILES
                for line in names.splitlines()
                if line.strip()
            )
    return 0, deps_changed, ""


def _do_pack_update(
    full: str, safe_ref: str | None, force: bool = False
) -> tuple[dict[str, Any] | None, str, str]:
    """Fetch then checkout/fast-forward one pack, capturing what changed.

    Returns (result, "", "") on success, or (None, error, code) on failure
    (code is "fetch_failed" or "checkout_failed"). ``result`` carries the
    before/after sha, the count + capped log of applied commits, the changed
    file count, and whether a dependency file changed. The sha range is built
    from values git produced — never caller input — so it is safe to interpolate.

    ``force`` discards uncommitted changes to TRACKED files (``checkout -f`` for
    an explicit ref, ``reset --hard`` to the upstream tip otherwise) so a pack
    with a dirty working tree can still be updated. Untracked files are left in
    place — force never runs ``git clean`` — so user-dropped files survive.
    """
    rc, before_out, _ = _git(["rev-parse", "HEAD"], full)
    before = before_out.strip() if rc == 0 else ""

    rc, _, err = _git(["fetch", "--all", "--tags"], full, timeout=120)
    if rc != 0:
        return None, err.strip() or "fetch failed", "fetch_failed"

    if safe_ref:
        args = ["checkout", "-f", safe_ref] if force else ["checkout", safe_ref]
        rc, _, err = _git(args, full, timeout=60)
    elif force:
        rc, _, err = _git(["reset", "--hard", "@{u}"], full, timeout=60)
    else:
        rc, _, err = _git(["merge", "--ff-only", "@{u}"], full, timeout=60)
    if rc != 0:
        return None, err.strip() or "checkout failed", "checkout_failed"

    rc, after_out, _ = _git(["rev-parse", "HEAD"], full)
    after = after_out.strip() if rc == 0 else ""

    result: dict[str, Any] = {
        "source": "git",
        "before": before or None,
        "after": after or None,
        "before_short": before[:7] or None,
        "after_short": after[:7] or None,
        "before_version": None,
        "after_version": None,
        "commits_applied": 0,
        "commit_log": [],
        "changed_files": 0,
        "deps_changed": False,
        "truncated": False,
    }
    if before and after and before != after:
        rng = f"{before}..{after}"
        rc, count, _ = _git(["rev-list", "--count", rng], full)
        if rc == 0:
            with contextlib.suppress(ValueError):
                result["commits_applied"] = int(count.strip())
        rc, logout, _ = _git(["log", f"-n{_UPDATE_LOG_CAP}", "--pretty=format:%h\t%s", rng], full)
        if rc == 0:
            entries: list[dict[str, str]] = []
            for line in logout.splitlines():
                sha, _, subject = line.partition("\t")
                if sha:
                    entries.append({"sha": sha, "subject": subject})
            result["commit_log"] = entries
            result["truncated"] = result["commits_applied"] > len(entries)
        rc, names, _ = _git(["diff", "--name-only", before, after], full)
        if rc == 0:
            files = [line for line in names.splitlines() if line.strip()]
            result["changed_files"] = len(files)
            result["deps_changed"] = any(os.path.basename(f) in _DEPS_FILES for f in files)
    return result, "", ""


def _remote_default_branch(cwd: str, remote: str = "origin") -> str | None:
    """The default branch of ``remote``, or None when it cannot be resolved.

    Asks the remote to (re)point ``refs/remotes/<remote>/HEAD`` at its current
    default branch and reads it back — so switching from a fork whose default is
    ``master`` to one whose default is ``main`` lands on the right branch
    instead of the previous repo's name.
    """
    _git(["remote", "set-head", remote, "-a"], cwd, timeout=30)
    rc, out, _ = _git(["symbolic-ref", "--short", f"refs/remotes/{remote}/HEAD"], cwd)
    prefix = f"{remote}/"
    if rc == 0 and out.strip().startswith(prefix):
        return out.strip()[len(prefix) :] or None
    return None


def _do_remote_switch(
    full: str, url: str, safe_ref: str | None, force: bool = False
) -> tuple[dict[str, Any] | None, str, str]:
    """Repoint a pack's ``origin`` at ``url`` and check the new repo out.

    This is the "switch to a different fork" operation: the pack DIRECTORY name
    is deliberately unchanged (it is part of the served
    ``/extensions/<pack>/`` URL and of ComfyUI's module identity), only the code
    inside it moves to another repository. Git history is kept, so a switch
    between related forks is an ordinary fetch + checkout rather than a
    re-clone, and switching back is symmetric.

    Returns (result, "", "") on success or (None, error, code) on failure. Every
    failure path RESTORES the previous remote URL, so a bad URL, an unreachable
    fork, or a checkout that will not apply leaves the pack exactly as it was
    (the only residue is fetched objects, which git will garbage-collect).

    ``safe_ref`` (already argument-injection-checked) picks an explicit branch or
    tag on the new remote; None takes the new remote's default branch. ``force``
    discards local changes to tracked files, mirroring ``_do_pack_update``.
    """
    old_url = _remote_url(full)
    rc, before_out, _ = _git(["rev-parse", "HEAD"], full)
    before = before_out.strip() if rc == 0 else ""

    args = ["remote", "set-url", "origin", url] if old_url else ["remote", "add", "origin", url]
    rc, _, err = _git(args, full)
    if rc != 0:
        return None, err.strip() or "could not set the remote", "remote_failed"

    def _restore() -> None:
        if old_url:
            _git(["remote", "set-url", "origin", old_url], full)
        else:
            _git(["remote", "remove", "origin"], full)

    rc, _, err = _git(["fetch", "--tags", "origin"], full, timeout=180)
    if rc != 0:
        _restore()
        return None, err.strip() or "fetch failed", "fetch_failed"

    target = safe_ref or _remote_default_branch(full)
    if not target:
        _restore()
        return None, "could not resolve a branch on the new remote", "checkout_failed"

    # A branch on the new remote gets a local branch reset onto it (so the pack
    # tracks the fork and later plain Updates fast-forward correctly); anything
    # else (a tag, a sha) is checked out detached, exactly like the version picker.
    rc, _, _ = _git(["rev-parse", "--verify", "--quiet", f"refs/remotes/origin/{target}"], full)
    if rc == 0:
        checkout = ["checkout", "-B", target, f"origin/{target}"]
        if force:
            checkout.insert(1, "--force")
    else:
        checkout = ["checkout", "-f", target] if force else ["checkout", target]
    rc, _, err = _git(checkout, full, timeout=60)
    if rc != 0:
        _restore()
        return None, err.strip() or "checkout failed", "checkout_failed"

    rc, after_out, _ = _git(["rev-parse", "HEAD"], full)
    after = after_out.strip() if rc == 0 else ""

    result: dict[str, Any] = {
        "remote_before": old_url,
        "remote_after": url,
        "ref": target,
        "before_short": before[:7] or None,
        "after_short": after[:7] or None,
        "changed_files": 0,
        "deps_changed": False,
    }
    # Both shas come from git, never from the caller — safe to pass as args.
    if before and after and before != after:
        rc, names, _ = _git(["diff", "--name-only", before, after], full)
        if rc == 0:
            files = [line for line in names.splitlines() if line.strip()]
            result["changed_files"] = len(files)
            result["deps_changed"] = any(os.path.basename(f) in _DEPS_FILES for f in files)
    return result, "", ""


def _do_registry_update(
    node_id: str, version: str | None, target: str
) -> tuple[dict[str, Any] | None, str, str]:
    """Re-download a registry pack's archive into an existing ``target`` dir.

    Mirrors ``_do_registry_install`` but REPLACES an existing pack instead of
    refusing when it already exists. The new archive is downloaded and staged
    BEFORE anything on disk changes; only once it is verified valid does the
    old dir get renamed aside and the staged one swapped in — a failure at any
    point before the swap leaves the original pack completely untouched, and a
    failure during the swap itself restores it. ``version`` None targets the
    registry's latest published version; when that already matches the pack's
    current version, nothing is downloaded.
    """
    root = os.path.dirname(target)
    before_version = _pyproject_project_meta(os.path.join(target, "pyproject.toml"))["version"]

    info = _registry_get(f"/nodes/{node_id}/install", {"version": version} if version else None)
    if not isinstance(info, dict):
        return None, "registry unavailable", "registry_unavailable"
    resolved_version = info.get("version") or version or before_version

    no_op_result: dict[str, Any] = {
        "source": "registry",
        "before_short": None,
        "after_short": None,
        "before_version": before_version,
        "after_version": before_version,
        "commits_applied": 0,
        "commit_log": [],
        "changed_files": 0,
        "deps_changed": False,
        "truncated": False,
    }
    if not version and resolved_version == before_version:
        return no_op_result, "", ""

    download_url = info.get("downloadUrl")
    if not _validate_archive_url(download_url):
        return None, "registry returned an unsupported download url", "invalid_archive_url"

    try:
        data = _fetch_bytes(download_url, MAX_ARCHIVE_BYTES)
    except Exception as exc:
        return None, str(exc) or "download failed", "download_failed"

    stage: str | None = tempfile.mkdtemp(prefix=".tm-reg-", dir=root)
    backup: str | None = None
    try:
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as zf:
                if not _zip_members_safe(zf):
                    return None, "unsafe archive member", "extract_failed"
                zf.extractall(stage)
        except zipfile.BadZipFile:
            return None, "bad zip archive", "extract_failed"

        entries = os.listdir(stage)
        if len(entries) == 1 and os.path.isdir(os.path.join(stage, entries[0])):
            pack_root = os.path.join(stage, entries[0])  # unwrap single dir
        else:
            pack_root = stage
        deps_changed = any(os.path.isfile(os.path.join(pack_root, f)) for f in _DEPS_FILES)

        # Dot-prefixed so a backup left behind by a crash mid-swap is skipped
        # by the installed listing (_iter_pack_dirs), same as the stage dir.
        backup = os.path.join(root, f".tm-reg-backup-{os.path.basename(target)}")
        if os.path.exists(backup):
            shutil.rmtree(backup, ignore_errors=True)
        os.rename(target, backup)
        try:
            os.rename(pack_root, target)
        except OSError as exc:
            os.rename(backup, target)  # restore the original pack
            backup = None
            return None, str(exc) or "swap failed", "install_failed"
        if pack_root == stage:
            stage = None  # the stage dir itself became the target

        return (
            {
                "source": "registry",
                "before_short": None,
                "after_short": None,
                "before_version": before_version,
                "after_version": resolved_version,
                "commits_applied": 1,
                "commit_log": [],
                "changed_files": 0,
                "deps_changed": deps_changed,
                "truncated": False,
            },
            "",
            "",
        )
    finally:
        if stage and os.path.isdir(stage):
            shutil.rmtree(stage, ignore_errors=True)
        if backup and os.path.isdir(backup):
            shutil.rmtree(backup, ignore_errors=True)  # old version — discard once swapped in


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
            "delete_allowed": _delete_allowed(),
        }
    )


@PromptServer.instance.routes.get("/touch_manager/installed")
async def installed(request: web.Request) -> web.Response:
    """List every pack dir across all custom_nodes roots."""
    packs = await _run(_collect_installed)
    return web.json_response({"ok": True, "packs": packs})


@PromptServer.instance.routes.get("/touch_manager/updates/list")
async def updates_list(request: web.Request) -> web.Response:
    """Fast list of updatable pack names (no fetch) so the UI can stream checks."""
    packs = await _run(_list_updatable_packs)
    return web.json_response({"ok": True, "packs": packs})


@PromptServer.instance.routes.get("/touch_manager/updates/check")
async def updates_check(request: web.Request) -> web.Response:
    """Check ONE pack for updates: git fetch + ahead/behind, or a registry
    version comparison for a non-git pack installed from the Comfy Registry.
    """
    name = _sanitize_name(request.rel_url.query.get("name", ""))
    if not name:
        return _err("missing or invalid name", "not_found", 400)
    full = _find_pack(name)
    if not full:
        return _err("not found", "not_found", 404)
    if await _run(_is_git, full):
        result = await _run(_check_one_update, full, name)
        return web.json_response({"ok": True, **result})
    meta = await _run(_registry_source_meta, full)
    if not meta:
        return _err("not a git repository", "not_git", 400)
    result = await _run(_check_one_registry_update, meta["id"], meta["version"], name)
    return web.json_response({"ok": True, **result})


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


@PromptServer.instance.routes.get("/touch_manager/forks")
async def forks(request: web.Request) -> web.Response:
    """List one pack's upstream repo and the forks it could switch to.

    GitHub-only and best-effort: a pack on another forge (or an unreachable
    API) returns empty lists alongside its current remote, and the frontend
    falls back to entering a repository URL by hand.
    """
    safe = _sanitize_name(request.rel_url.query.get("name", ""))
    if not safe:
        return _err("missing or invalid name", "not_found", 400)
    full = _find_pack(safe, include_disabled=True)
    if not full or not _is_git(full):
        return _err("not found", "not_found", 404)
    remote = await _run(_remote_url, full)
    data = await _run(_collect_forks, remote)
    return web.json_response({"ok": True, "name": safe, "current": remote, **data})


@PromptServer.instance.routes.get("/touch_manager/registry/search")
async def registry_search(request: web.Request) -> web.Response:
    """Search the Comfy Registry (server-side proxy; normalised subset)."""
    q = request.rel_url.query.get("q", "").strip()
    page = _coerce_page(request.rel_url.query.get("page", "1"))
    data = await _run(
        _registry_get, "/nodes", {"page": page, "limit": REGISTRY_PAGE_SIZE, "search": q}
    )
    if not isinstance(data, dict):
        return _err("registry unavailable", "registry_unavailable", 502)
    nodes = [_normalize_registry_node(n) for n in data.get("nodes", []) if isinstance(n, dict)]
    return web.json_response(
        {
            "ok": True,
            "page": data.get("page", page),
            "total_pages": data.get("totalPages", 1),
            "nodes": nodes,
        }
    )


@PromptServer.instance.routes.get("/touch_manager/registry/versions")
async def registry_versions(request: web.Request) -> web.Response:
    """List the published versions of one registry node."""
    node_id = _sanitize_name(request.rel_url.query.get("id", ""))
    if not node_id:
        return _err("missing or invalid id", "invalid_id", 400)
    data = await _run(_registry_get, f"/nodes/{node_id}/versions")
    if data is None:
        return _err("registry unavailable", "registry_unavailable", 502)
    if isinstance(data, list):
        items = data
    elif isinstance(data, dict):
        items = data.get("versions", [])
    else:
        items = []
    versions = [
        {
            "version": v.get("version"),
            "deprecated": bool(v.get("deprecated")),
            "createdAt": v.get("createdAt"),
        }
        for v in items
        if isinstance(v, dict) and v.get("version")
    ]
    return web.json_response({"ok": True, "id": node_id, "versions": versions})


@PromptServer.instance.routes.post("/touch_manager/registry/install")
async def registry_install(request: web.Request) -> web.Response:
    """Download + safely extract a registry node version into custom_nodes."""
    body = await _body(request)
    # Same bind gate as git install — this fetches and writes node code too.
    if not _install_allowed():
        return _err("install disabled on non-loopback bind", "blocked_remote_bind", 403)

    node_id = _sanitize_name(str(body.get("id", "")))
    if not node_id:
        return _err("missing or invalid id", "invalid_id", 400)

    raw_version = body.get("version")
    version = _safe_version(raw_version) if raw_version else None
    if raw_version and version is None:
        return _err("invalid version", "invalid_version", 400)

    name = _sanitize_name(str(body.get("name") or node_id))
    if not name:
        return _err("invalid name", "invalid_id", 400)

    roots = _custom_nodes_roots()
    if not roots:
        return _err("no custom_nodes root available", "install_failed", 500)
    root = roots[0]

    info = await _run(
        _registry_get, f"/nodes/{node_id}/install", {"version": version} if version else None
    )
    if not isinstance(info, dict):
        return _err("registry unavailable", "registry_unavailable", 502)
    download_url = info.get("downloadUrl")
    if not _validate_archive_url(download_url):
        return _err("registry returned an unsupported download url", "invalid_archive_url", 502)

    result, err, code = await _run(_do_registry_install, download_url, name, root)
    if result is None:
        return _err(err, code, 409 if code == "exists" else 500)
    # Fresh install: install its Python deps so the node loads on next start.
    deps = await _run(_install_deps, os.path.join(root, name))
    return web.json_response(
        {
            "ok": True,
            "name": name,
            "version": version or info.get("version"),
            "source": "registry",
            "deps_changed": result["deps_changed"],
            "deps": deps,
            "restart_required": True,
        }
    )


@PromptServer.instance.routes.post("/touch_manager/install")
async def install(request: web.Request) -> web.Response:
    """Clone an allowlisted github/gitlab URL into the first custom_nodes root."""
    body = await _body(request)
    # Bind gate FIRST — never reach validation/clone on a non-loopback bind
    # unless the operator explicitly opted in.
    if not _install_allowed():
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

    # Fresh clone: install its Python deps so the pack loads on next start.
    deps = await _run(_install_deps, target)
    return web.json_response({"ok": True, "name": name, "deps": deps, "restart_required": True})


@PromptServer.instance.routes.post("/touch_manager/update")
async def update(request: web.Request) -> web.Response:
    """Update one pack: git fetch+checkout for a git pack, or a fresh archive
    download for a pack installed from the Comfy Registry (which is not a git
    checkout — there is nothing to fetch/checkout).
    """
    body = await _body(request)
    name = _sanitize_name(str(body.get("name", "")))
    if not name:
        return _err("not found", "not_found", 404)
    full = _find_pack(name)
    if not full:
        return _err("not found", "not_found", 404)

    if await _run(_is_git, full):
        # Validate any explicit ref BEFORE fetching so a malicious ref never
        # reaches git (argument-injection guard — see _safe_ref).
        ref = body.get("ref")
        safe_ref = _safe_ref(ref) if ref else None
        if ref and safe_ref is None:
            return _err("invalid ref", "checkout_failed", 400)

        force = bool(body.get("force"))
        result, err, code = await _run(_do_pack_update, full, safe_ref, force)
        if result is None:
            return _err(err, code, 500)
        # Only reinstall when the update actually touched a dependency file — an
        # unrelated update should not pay for a full pip resolve.
        result["deps"] = await _run(_install_deps, full) if result["deps_changed"] else _no_deps()
        return web.json_response({"ok": True, "name": name, "restart_required": True, **result})

    meta = await _run(_registry_source_meta, full)
    if not meta:
        return _err("not a git repository", "not_git", 400)

    raw_version = body.get("version")
    version = _safe_version(raw_version) if raw_version else None
    if raw_version and version is None:
        return _err("invalid version", "invalid_version", 400)

    result, err, code = await _run(_do_registry_update, meta["id"], version, full)
    if result is None:
        return _err(err, code, 500)
    result["deps"] = await _run(_install_deps, full) if result["deps_changed"] else _no_deps()
    return web.json_response({"ok": True, "name": name, "restart_required": True, **result})


@PromptServer.instance.routes.post("/touch_manager/remote")
async def remote(request: web.Request) -> web.Response:
    """Switch one git pack to a different fork, in place.

    Same bind gate as /install: this lands code from an arbitrary allowlisted
    repository, so it is refused on a non-loopback bind without the operator's
    opt-in. A dirty working tree is refused with 409 ``dirty`` unless ``force``
    is set (which discards local changes to tracked files).
    """
    body = await _body(request)
    if not _install_allowed():
        return _err("install disabled on non-loopback bind", "blocked_remote_bind", 403)

    name = _sanitize_name(str(body.get("name", "")))
    if not name:
        return _err("not found", "not_found", 404)
    full = _find_pack(name)
    if not full:
        return _err("not found", "not_found", 404)
    if not await _run(_is_git, full):
        return _err("not a git repository", "not_git", 400)

    url = body.get("url")
    if _validate_url(url)[1]:
        return _err("invalid repository url", "invalid_url", 400)

    # Validate the ref BEFORE touching the remote so a malicious ref never
    # reaches git (argument-injection guard — see _safe_ref).
    ref = body.get("ref")
    safe_ref = _safe_ref(ref) if ref else None
    if ref and safe_ref is None:
        return _err("invalid ref", "checkout_failed", 400)

    force = bool(body.get("force"))
    if not force and await _run(_is_dirty, full):
        return _err("pack has local changes", "dirty", 409)

    result, err, code = await _run(_do_remote_switch, full, url, safe_ref, force)
    if result is None:
        return _err(err, code, 500)
    # Switching forks can land an entirely different dependency set — install it
    # whenever a dependency file differs between the two checkouts.
    result["deps"] = await _run(_install_deps, full) if result["deps_changed"] else _no_deps()
    return web.json_response({"ok": True, "name": name, "restart_required": True, **result})


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


@PromptServer.instance.routes.post("/touch_manager/enable")
async def enable(request: web.Request) -> web.Response:
    """Re-enable a disabled pack by dropping the ``.disabled`` suffix.

    The inverse of ``uninstall``: renames ``<name>.disabled`` back to ``<name>``
    so ComfyUI imports it again on the next restart. Idempotent when the pack is
    already enabled; refuses (409) when an enabled dir of the same name already
    exists (renaming over it would clobber it).
    """
    body = await _body(request)
    name = _sanitize_name(str(body.get("name", "")))
    if not name:
        return _err("not found", "not_found", 404)
    full = _find_pack(name, include_disabled=True)
    if not full:
        return _err("not found", "not_found", 404)
    if not full.endswith(_DISABLED_SUFFIX):
        # Already enabled — nothing to do, and nothing to restart for.
        return web.json_response({"ok": True, "name": name, "restart_required": False})

    target = full[: -len(_DISABLED_SUFFIX)]
    if os.path.exists(target):
        return _err("a pack with that name is already enabled", "conflict", 409)
    try:
        os.rename(full, target)
    except OSError as exc:
        return _err(str(exc), "rename_failed", 500)

    return web.json_response({"ok": True, "name": name, "restart_required": True})


@PromptServer.instance.routes.post("/touch_manager/delete")
async def delete(request: web.Request) -> web.Response:
    """Permanently remove a pack directory — the irreversible sibling of uninstall.

    ``uninstall`` renames a pack to ``<name>.disabled`` and can be undone from
    the UI; this unlinks the directory and everything in it, including any local
    edits. Gated on loopback (or TOUCH_MANAGER_ALLOW_REMOTE_DELETE=1), and
    refuses any pack path that does not resolve inside its own custom_nodes root
    — so a symlinked pack dir deletes nothing outside the tree.
    """
    if not _delete_allowed():
        return _err("delete disabled on non-loopback bind", "delete_disabled", 403)
    body = await _body(request)
    name = _sanitize_name(str(body.get("name", "")))
    if not name:
        return _err("not found", "not_found", 404)
    # Disabled packs are deletable too — a pack disabled and then deleted is the
    # ordinary "try it, then get rid of it" path.
    full = _find_pack(name, include_disabled=True)
    if not full:
        return _err("not found", "not_found", 404)

    root = os.path.dirname(full)
    if os.path.islink(full) or not _within_root(full, root):
        return _err("pack path escapes its custom_nodes root", "invalid_target", 400)

    try:
        await _run(shutil.rmtree, full)
    except OSError as exc:
        return _err(str(exc) or "delete failed", "delete_failed", 500)

    return web.json_response({"ok": True, "name": name, "path": full, "restart_required": True})


@PromptServer.instance.routes.get("/touch_manager/core")
async def core(request: web.Request) -> web.Response:
    """Report the core repo's ref, behind counts, dirtiness, and remotes."""
    info = await _run(_collect_core, _core_dir())
    return web.json_response({"ok": True, **info})


@PromptServer.instance.routes.post("/touch_manager/core/update")
async def core_update(request: web.Request) -> web.Response:
    """git pull the core repo; install its deps when a dependency file changed.

    Installs into the running interpreter (see _install_deps) but does NOT
    restart — the restart stays a user action.
    """
    cwd = _core_dir()
    if not await _run(_is_git, cwd):
        return _err("core is not a git repository", "not_git", 400)
    rc, deps_changed, err = await _run(_do_core_pull, cwd)
    if rc != 0:
        return _err(err or "pull failed", "pull_failed", 500)
    deps = await _run(_install_deps, cwd) if deps_changed else _no_deps()
    return web.json_response(
        {"ok": True, "deps_changed": deps_changed, "deps": deps, "restart_required": True}
    )


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
