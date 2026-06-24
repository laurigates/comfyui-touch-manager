import { describe, expect, it } from "vitest";
// Vitest transpiles TypeScript, so the test imports the `.ts` source directly
// (no build step). Importing index.ts also confirms the registerExtension
// wiring loads cleanly against tests/js/__mocks__/app.js (the module
// side-effect runs against the stub). The pure helpers are re-exported from the
// barrel; manager-core.test.js covers them in depth.
import { filterPacks, formatRef, sanitizePackName, validateInstallUrl } from "../../src/index.ts";

describe("comfyui-touch-manager extension barrel", () => {
  it("loads index.ts (registerExtension) and re-exports the pure helpers", () => {
    expect(typeof validateInstallUrl).toBe("function");
    expect(typeof filterPacks).toBe("function");
    expect(typeof formatRef).toBe("function");
    expect(typeof sanitizePackName).toBe("function");
  });

  it("validates a canonical github URL through the barrel re-export", () => {
    const v = validateInstallUrl("https://github.com/owner/my-pack");
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.name).toBe("my-pack");
  });
});
