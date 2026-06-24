// Stub of ComfyUI's scripts/app.js for the Vitest harness. Extension-module
// tests import `app` (aliased here via vitest.config) without a real frontend.
//
// Beyond the no-op registerExtension the pure-function tests need, this mock
// also models the small `app.api` + `app.extensionManager` surface the modal
// UI reaches into, so the jsdom modal smoke test can drive openManager() and
// assert on the rendered DOM + which /touch_manager routes were called.

// Records every fetchApi(url) the code under test makes (assert on these).
export const __fetchCalls = [];

// Mutable map: substring of the apiURL -> JSON body fetchApi resolves with.
// Tests set entries before exercising the UI; unmatched routes resolve {ok:true}.
export const __responses = {};

export function __reset() {
  __fetchCalls.length = 0;
  for (const k of Object.keys(__responses)) delete __responses[k];
}

export const app = {
  registerExtension() {},
  graph: { _nodes: [] },
  extensionManager: {
    toast: { add() {} },
    dialog: {
      confirm: async () => true,
      prompt: async () => null,
    },
    setting: { get: () => false, set() {} },
    registerSidebarTab() {},
  },
  api: {
    apiURL: (path) => path,
    fetchApi: async (url) => {
      __fetchCalls.push(url);
      const key = Object.keys(__responses).find((k) => String(url).includes(k));
      const body = key ? __responses[key] : { ok: true };
      return { ok: true, status: 200, json: async () => body };
    },
  },
};
