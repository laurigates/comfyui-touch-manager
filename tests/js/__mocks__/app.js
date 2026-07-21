// Stub of ComfyUI's scripts/app.js for the Vitest harness. Extension-module
// tests import `app` (aliased here via vitest.config) without a real frontend.
//
// Beyond the no-op registerExtension the pure-function tests need, this mock
// also models the small `app.api` + `app.extensionManager` surface the modal
// UI reaches into, so the jsdom modal smoke test can drive openManager() and
// assert on the rendered DOM + which /touch_manager routes were called.

// Records every fetchApi(url) the code under test makes (assert on these).
export const __fetchCalls = [];

// Parallel record of {url, method, body} for each call, so a test can assert on
// a POST's JSON body (e.g. the `force` flag) — kept separate from __fetchCalls
// so its "array of URL strings" contract stays intact.
export const __fetchBodies = [];

// Mutable map: substring of the apiURL -> JSON body fetchApi resolves with.
// Tests set entries before exercising the UI; unmatched routes resolve {ok:true}.
export const __responses = {};

// Reconnect-watch tests need to simulate the server being down: while
// `failNext > 0`, each fetchApi call rejects (as a real dropped connection
// would) and decrements the counter, so a test can make the first N probes
// "fail" and the next one succeed.
export const __fetchControl = { failNext: 0 };

export function __reset() {
  __fetchCalls.length = 0;
  __fetchBodies.length = 0;
  __fetchControl.failNext = 0;
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
    fetchApi: async (url, opts) => {
      __fetchCalls.push(url);
      let reqBody;
      try {
        reqBody = opts?.body ? JSON.parse(opts.body) : undefined;
      } catch {
        reqBody = opts?.body;
      }
      __fetchBodies.push({ url: String(url), method: opts?.method ?? "GET", body: reqBody });
      if (__fetchControl.failNext > 0) {
        __fetchControl.failNext -= 1;
        throw new Error("network down");
      }
      const key = Object.keys(__responses).find((k) => String(url).includes(k));
      const body = key ? __responses[key] : { ok: true };
      return { ok: true, status: 200, json: async () => body };
    },
  },
};
