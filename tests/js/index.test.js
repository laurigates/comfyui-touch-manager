import { describe, expect, it } from "vitest";
// Vitest transpiles TypeScript, so the test imports the `.ts` source directly
// (no build step). Importing the module also confirms the registerExtension
// wiring loads cleanly against tests/js/__mocks__/app.js.
import { clampToTargets } from "../../src/index.ts";

// Smoke test so `bun run test` is green from the first commit. Exercises the
// placeholder pure helper; replace with real tests of this pack's helpers as
// they land. Add at least one jsdom DOM-attach test per modal builder (assert
// the expected element exists in modal.bodyEl after openX()) — the gate below
// covers pure helpers only, which is exactly the gap that let an empty-modal
// bug ship green. Use `vitest --environment jsdom` for those.
describe("comfyui-touch-manager harness", () => {
  it("recognises a target widget name and rejects a non-target", () => {
    expect(clampToTargets("")).toBe(false);
    expect(clampToTargets("definitely-not-a-target-widget")).toBe(false);
  });
});
