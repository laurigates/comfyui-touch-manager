"""Stub ComfyUI-bundled imports so touch_manager.py can be imported in a vanilla
Python environment for unit tests. The dev group ships none of these — they only
exist inside a ComfyUI install — so the module-level imports would otherwise
fail collection.

Stubbed:
- aiohttp.web — a real json_response/Request/Response so endpoint tests can
  assert on resp.status / resp.json_body and POST handlers can await
  request.json().
- folder_paths — base_path attr + get_folder_paths(category) -> list. Tests set
  the specific attributes they need on the stub.
- comfy.cli_args — args.listen, read defensively by the backend's bind gate.
- server.PromptServer — the @routes.get/@routes.post decorators return the
  wrapped handler unchanged (tests then await those coroutines directly).
"""

from __future__ import annotations

import sys
from types import ModuleType, SimpleNamespace
from unittest.mock import MagicMock


class _StubModule(ModuleType):
    def __getattr__(self, attr: str):
        if attr.startswith("__"):
            raise AttributeError(attr)
        m = MagicMock()
        setattr(self, attr, m)
        return m


def _ensure_stub(name: str) -> ModuleType:
    if name in sys.modules and not isinstance(sys.modules[name], _StubModule):
        return sys.modules[name]
    m = _StubModule(name)
    sys.modules[name] = m
    return m


# aiohttp — the backend does `from aiohttp import web`. Provide a `web`
# submodule with a real json_response/Request/Response so endpoint tests can
# assert on the returned objects.
_aiohttp = _ensure_stub("aiohttp")
_web = _ensure_stub("aiohttp.web")


class _Response:
    def __init__(self, *, body=None, status=200, content_type=None, headers=None):
        self.body = body
        self.status = status
        self.content_type = content_type
        self.headers = headers or {}


class _JsonResponse(_Response):
    def __init__(self, data, *, status=200):
        super().__init__(body=data, status=status, content_type="application/json")
        self.json_body = data


def _json_response(data, *, status=200):
    return _JsonResponse(data, status=status)


class _Request:
    """Minimal aiohttp.web.Request stand-in.

    GET handlers read ``.rel_url.query``; POST handlers ``await request.json()``.
    """

    def __init__(self, query=None, json_body=None):
        self.rel_url = SimpleNamespace(query=dict(query or {}))
        self._json_body = json_body

    async def json(self):
        if self._json_body is None:
            raise ValueError("no json body")
        return self._json_body


_web.json_response = _json_response
_web.Response = _Response
_web.Request = _Request
_aiohttp.web = _web

# folder_paths — backend reads base_path + get_folder_paths("custom_nodes").
_ensure_stub("folder_paths")

# comfy.cli_args — the bind gate reads args.listen defensively.
_comfy = _ensure_stub("comfy")
_cli_args = _ensure_stub("comfy.cli_args")
_cli_args.args = SimpleNamespace(listen="")
_comfy.cli_args = _cli_args

# ComfyUI core `server` — the backend does `from server import PromptServer`.
_server = _ensure_stub("server")


class _NoopRoutes:
    """Decorator-shaped no-op for @PromptServer.instance.routes.get/post(path)."""

    def get(self, path):
        def deco(fn):
            return fn

        return deco

    def post(self, path):
        return self.get(path)


# PromptServer.instance.routes is read at module load; supply a real object so
# the @decorator calls in touch_manager.py return their wrapped function.
_server.PromptServer = SimpleNamespace(instance=SimpleNamespace(routes=_NoopRoutes()))
