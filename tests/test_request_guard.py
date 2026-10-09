"""The browser-reachability guard on every state-changing /touch_manager route.

Registry moderation flagged 0.1.23 (issue #75): a cross-origin page could
drive POST /touch_manager/install — clone an attacker-named repository, then
pip-install its requirements into the running interpreter — because
``request.json()`` in aiohttp parses a ``text/plain`` body without checking the
Content-Type, and a ``text/plain`` POST is a CORS *simple* request: the browser
sends it with no preflight.

ComfyUI's default origin middleware blocks that request on a current core, but
the pack cannot rely on it: ``--enable-cors-header`` replaces that middleware
outright, the ``Sec-Fetch-Site`` check only landed in ComfyUI in 2026-04
(Comfy-Org/ComfyUI#13261), and a DNS-rebound page is same-origin to the
browser, so it passes both checks.

The guard therefore has three parts, each pinned here:

1. Every POST route requires the ``X-Touch-Manager: 1`` header. A custom
   header makes the request non-simple, so a cross-origin page must preflight
   first, and no ComfyUI middleware approves that header in a preflight.
2. ``Sec-Fetch-Site: cross-site`` is refused in the pack as well, so the
   refusal does not depend on which middleware ComfyUI installed.
3. The loopback-trust gates (install, remote, registry install, delete,
   reboot) require the request to arrive under a loopback Host, so a page on
   ``attacker.example`` rebound to 127.0.0.1 is treated as remote.
"""

from __future__ import annotations

import asyncio
import re
from pathlib import Path

import comfy.cli_args
import folder_paths
import pytest
from aiohttp.web import Request

import touch_manager as pack

ROOT = Path(__file__).resolve().parent.parent
PY_SRC = (ROOT / "touch_manager.py").read_text()

# The exact shape of the flagged attack: a JSON payload in a text/plain body,
# no custom header, no Sec-Fetch-Site (an older browser, or a page served from
# the attacker's own origin under --enable-cors-header).
EVIL_URL = "https://github.com/attacker/payload"


def _post_routes() -> list[tuple[str, str]]:
    """(route, handler-name) for every POST route registered in the backend.

    Read from the source, not hand-listed, so a POST route added later without
    the guard fails the parametrized tests below instead of slipping through.
    """
    return re.findall(
        r'routes\.post\(\s*"(/touch_manager/[^"]+)"\s*\)\s*\n(?:@[^\n]+\n)*async def (\w+)',
        PY_SRC,
    )


POST_ROUTES = _post_routes()


def _call(handler, headers, **body):
    return asyncio.run(handler(Request(json_body=body, headers=headers)))


@pytest.fixture
def recorded(monkeypatch, tmp_path):
    """Loopback bind, a real custom_nodes root, and git/pip/rmtree/execv recorders.

    Any side effect a refused request must never reach lands in ``calls``.
    """
    monkeypatch.setattr(comfy.cli_args.args, "listen", "")
    for var in (
        "TOUCH_MANAGER_ALLOW_REMOTE_INSTALL",
        "TOUCH_MANAGER_ALLOW_REMOTE_DELETE",
        "TOUCH_MANAGER_ALLOW_REMOTE_REBOOT",
    ):
        monkeypatch.delenv(var, raising=False)
    root = tmp_path / "custom_nodes"
    root.mkdir()
    (root / "victim").mkdir()
    folder_paths.get_folder_paths = lambda category: [str(root)]

    calls: list[tuple] = []

    def fake_git(args, cwd, timeout=60):
        calls.append(("git", tuple(args)))
        return 0, "", ""

    monkeypatch.setattr(pack, "_git", fake_git)
    monkeypatch.setattr(pack, "_pip_install", lambda *a, **k: calls.append(("pip", a)) or (0, ""))
    monkeypatch.setattr(pack.shutil, "rmtree", lambda *a, **k: calls.append(("rmtree", a)))
    monkeypatch.setattr(pack.os, "execv", lambda *a: calls.append(("execv", a)))
    monkeypatch.setattr(pack, "_registry_get", lambda *a, **k: calls.append(("registry", a)))
    return calls


def test_route_parser_found_every_mutating_route():
    # Guard against a silent regex break that would make the parametrize empty.
    routes = {r for r, _ in POST_ROUTES}
    assert {
        "/touch_manager/install",
        "/touch_manager/registry/install",
        "/touch_manager/remote",
        "/touch_manager/update",
        "/touch_manager/uninstall",
        "/touch_manager/enable",
        "/touch_manager/delete",
        "/touch_manager/core/update",
        "/touch_manager/reboot",
    } <= routes
    assert len(routes) == len(re.findall(r"routes\.post\(", PY_SRC))


@pytest.mark.parametrize(("route", "handler_name"), POST_ROUTES)
def test_every_post_route_refuses_a_request_without_the_marker_header(
    recorded, route, handler_name
):
    handler = getattr(pack, handler_name)
    resp = _call(
        handler,
        {"Host": "127.0.0.1:8188", "Content-Type": "text/plain"},
        url=EVIL_URL,
        name="victim",
        id="victim",
    )
    assert resp.status == 403, route
    assert resp.json_body["code"] == "csrf_rejected", route
    assert recorded == [], f"{route} reached a side effect: {recorded}"


@pytest.mark.parametrize(("route", "handler_name"), POST_ROUTES)
def test_every_post_route_refuses_a_cross_site_fetch_even_with_the_header(
    recorded, route, handler_name
):
    handler = getattr(pack, handler_name)
    resp = _call(
        handler,
        {"Host": "127.0.0.1:8188", "X-Touch-Manager": "1", "Sec-Fetch-Site": "cross-site"},
        url=EVIL_URL,
        name="victim",
    )
    assert resp.status == 403, route
    assert resp.json_body["code"] == "csrf_rejected", route
    assert recorded == [], f"{route} reached a side effect: {recorded}"


def test_the_flagged_text_plain_csrf_payload_never_clones(recorded):
    # The registry's reproduction, verbatim in shape: a form-encoded-looking
    # text/plain POST carrying a JSON object, which request.json() would parse.
    resp = _call(
        pack.install, {"Host": "localhost:8188", "Content-Type": "text/plain"}, url=EVIL_URL
    )
    assert resp.status == 403
    assert not any(c[0] == "git" for c in recorded)
    assert not any(c[0] == "pip" for c in recorded)


@pytest.mark.parametrize("value", ["", "0", "true", "yes"])
def test_the_marker_header_must_be_exactly_one(recorded, value):
    resp = _call(pack.install, {"Host": "127.0.0.1:8188", "X-Touch-Manager": value}, url=EVIL_URL)
    assert resp.status == 403
    assert resp.json_body["code"] == "csrf_rejected"


@pytest.mark.parametrize("site", ["same-origin", "none", None])
def test_a_same_origin_request_with_the_header_passes_the_guard(recorded, site):
    headers = {"Host": "127.0.0.1:8188", "X-Touch-Manager": "1"}
    if site is not None:
        headers["Sec-Fetch-Site"] = site
    # An invalid URL proves the request got PAST the guard and into validation.
    resp = _call(pack.install, headers, url="not-a-url")
    assert resp.status == 400
    assert resp.json_body["code"] == "invalid_url"


def test_get_routes_need_no_marker_header(monkeypatch):
    # Read-only routes stay plain GETs: /config doubles as the restart probe.
    monkeypatch.setattr(comfy.cli_args.args, "listen", "")
    resp = asyncio.run(pack.config(Request(headers={"Host": "127.0.0.1:8188"})))
    assert resp.status == 200


# ---------------------------------------------------------------------------
# DNS rebinding: a loopback bind reached under a non-loopback Host is remote
# ---------------------------------------------------------------------------

REBOUND = {
    "Host": "attacker.example:8188",
    "X-Touch-Manager": "1",
    "Sec-Fetch-Site": "same-origin",
}


@pytest.mark.parametrize(
    ("handler_name", "code"),
    [
        ("install", "blocked_remote_bind"),
        ("remote", "blocked_remote_bind"),
        ("registry_install", "blocked_remote_bind"),
        ("delete", "delete_disabled"),
        ("reboot", "reboot_disabled"),
    ],
)
def test_a_rebound_host_does_not_get_loopback_trust(recorded, handler_name, code):
    resp = _call(getattr(pack, handler_name), REBOUND, url=EVIL_URL, name="victim", id="victim")
    assert resp.status == 403
    assert resp.json_body["code"] == code
    assert recorded == []


def test_config_reports_a_rebound_host_as_not_loopback(monkeypatch):
    monkeypatch.setattr(comfy.cli_args.args, "listen", "")
    for var in ("TOUCH_MANAGER_ALLOW_REMOTE_DELETE", "TOUCH_MANAGER_ALLOW_REMOTE_REBOOT"):
        monkeypatch.delenv(var, raising=False)
    body = asyncio.run(pack.config(Request(headers={"Host": "attacker.example:8188"}))).json_body
    assert body["is_loopback"] is False
    assert body["delete_allowed"] is False
    assert body["reboot_allowed"] is False


@pytest.mark.parametrize(
    "host",
    ["127.0.0.1:8188", "localhost:8188", "LOCALHOST", "[::1]:8188", "127.0.0.2:8188", None],
)
def test_loopback_hosts_keep_loopback_trust(recorded, host):
    headers = {"X-Touch-Manager": "1"}
    if host is not None:
        headers["Host"] = host
    resp = _call(pack.install, headers, url="not-a-url")
    # Past both the guard and the bind gate, into URL validation.
    assert resp.json_body["code"] == "invalid_url", host


@pytest.mark.parametrize("host", ["192.168.1.5:8188", "comfy.lan", "localhost.attacker.example"])
def test_non_loopback_hosts_on_a_loopback_bind_are_remote(recorded, host):
    resp = _call(pack.install, {"Host": host, "X-Touch-Manager": "1"}, url=EVIL_URL)
    assert resp.json_body["code"] == "blocked_remote_bind", host


def test_the_operator_opt_in_still_admits_a_non_loopback_host(recorded, monkeypatch):
    # TOUCH_MANAGER_ALLOW_REMOTE_INSTALL is the operator saying "remote callers
    # may install" — a reverse proxy under its own name is that case.
    monkeypatch.setenv("TOUCH_MANAGER_ALLOW_REMOTE_INSTALL", "1")
    resp = _call(pack.install, {"Host": "comfy.lan", "X-Touch-Manager": "1"}, url="not-a-url")
    assert resp.json_body["code"] == "invalid_url"
