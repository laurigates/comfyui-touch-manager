"""Frontend <-> backend route contract test (no JS execution).

The frontend (src/touch-manager-ui.ts) reaches the backend through two thin
helpers, ``apiGet(path)`` / ``apiPost(path, body)``, which prefix the relative
``path`` with ``/touch_manager/``. The backend registers each route with a
``@PromptServer.instance.routes.get|post("/touch_manager/<x>")`` decorator.

If the two drift — a frontend call to a route the backend never registered, or
a core route the frontend forgot to consume — a real interaction 404s at
runtime with nothing catching it. This guards the contract by parsing route
strings out of BOTH sources (no bundler, no browser) and asserting they line
up. It mirrors comfyui-model-gallery's category-gate consistency test.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PY_SRC = (ROOT / "touch_manager.py").read_text()
# The frontend route strings live in the modal UI module (apiGet/apiPost) and
# the entry barrel; read all of src/*.ts so a moved call is still covered.
TS_SRC = "\n".join(p.read_text() for p in sorted((ROOT / "src").glob("*.ts")))

# Backend routes registered with no frontend caller, by design. (None today —
# every backend route, including reboot, now has a UI caller.)
_BACKEND_ONLY: set[str] = set()


def _backend_routes() -> set[str]:
    """Every route registered under /touch_manager/ in the backend."""
    return set(re.findall(r'routes\.(?:get|post)\(\s*"/touch_manager/([^"]+)"', PY_SRC))


def _frontend_routes() -> set[str]:
    """Every relative path the frontend passes to apiGet / apiPost.

    Captures the first string/template-literal argument, stripping any query
    string (e.g. ``versions?name=...`` -> ``versions``). Matches calls with or
    without an explicit ``<T>`` type parameter; skips the helper definitions
    (whose first arg is the bare identifier ``path``, not a quoted literal).
    """
    routes = re.findall(
        r"""api(?:Get|Post)\s*(?:<[^>]*>)?\s*\(\s*[`"']([^`"'?]+)""",
        TS_SRC,
    )
    return {r.strip() for r in routes}


def test_parsers_found_routes() -> None:
    # Guard against a silent regex break that would make the asserts vacuous.
    be = _backend_routes()
    fe = _frontend_routes()
    assert {"config", "installed", "install", "core/update", "reboot"} <= be
    assert {"config", "installed", "install", "core/update"} <= fe


def test_every_frontend_route_is_registered_in_the_backend() -> None:
    fe = _frontend_routes()
    be = _backend_routes()
    missing = fe - be
    assert not missing, f"frontend calls routes the backend does not register: {sorted(missing)}"


def test_every_backend_route_is_consumed_by_the_frontend() -> None:
    # Every backend route must have a frontend caller or it is dead surface.
    be = _backend_routes() - _BACKEND_ONLY
    fe = _frontend_routes()
    unused = be - fe
    assert not unused, f"backend routes with no frontend caller: {sorted(unused)}"


def test_reboot_is_consumed_by_the_frontend() -> None:
    # The restart button wires the reboot route into the UI.
    assert "reboot" in _backend_routes()
    assert "reboot" in _frontend_routes()
