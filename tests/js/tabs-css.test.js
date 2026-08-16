// @vitest-environment jsdom
//
// The tab bar's treatment, pinned in the two tiers that can see it.
//
// The four tabs are ONE choice, not four actions, so they render as the
// family's segmented control: a bordered container holding transparent
// segments with a tinted active one (comfyui-image-browser `.ib-tabs`,
// comfyui-gallery-loader `.ip-tabs`). What is NOT copied from those packs is
// their 32px segment height — below the 44px touch floor — so the sizing
// assertions below are as load-bearing as the look ones.
//
// Tier split (.claude/rules/modal-pack-test-tiers.md):
//   - `border` / `background` shorthands and the active tint are read off the
//     CSS SOURCE. jsdom's cascade resolves them, but a shorthand read back
//     through getComputedStyle is normalised in ways that make "does the
//     container carry a border and the segment not" awkward to state.
//   - `min-height` is read through getComputedStyle on a real rendered
//     segment, which is the assertion that proves the rule actually reaches
//     the element rather than merely existing in a string.
// Whether the pill visually hugs its segments is a browser-tier question
// (`comfyui-plugin:comfyui-pack-live-smoke`); nothing here can answer it.
import { beforeEach, describe, expect, it } from "vitest";
import { CSS, openManager } from "../../src/touch-manager-ui.ts";
import { __reset, __responses } from "./__mocks__/app.js";

const flush = () => new Promise((r) => setTimeout(r, 0));

// Slice out `<selector> { ... }`. Declarations contain no nested braces, so a
// scan to the first `}` is exact. Returns null when the selector is absent, so
// a renamed rule fails loudly instead of matching an empty string.
function ruleBlock(css, selector) {
  const i = css.indexOf(`${selector} {`);
  if (i === -1) return null;
  const end = css.indexOf("}", i);
  return css.slice(i + selector.length + 1, end);
}

describe("tab bar CSS source", () => {
  const tabs = ruleBlock(CSS, ".tm-tabs");
  const tab = ruleBlock(CSS, ".tm-tab");
  const active = ruleBlock(CSS, ".tm-tab.tm-active");

  it("draws one bordered container, not four bordered buttons", () => {
    expect(tabs).not.toBeNull();
    expect(tab).not.toBeNull();
    // The container owns the border...
    expect(tabs).toMatch(/border:\s*1px solid/);
    expect(tabs).toMatch(/border-radius:/);
    // ...and the segments inside it must not, or the group reads as four
    // separate buttons again — the exact divergence this rule exists to fix.
    expect(tab).toMatch(/border:\s*0\b/);
    expect(tab).toMatch(/background:\s*transparent/);
  });

  it("tints the active segment instead of filling it with the primary colour", () => {
    expect(active).not.toBeNull();
    // Two-sided: a tint is present AND it is translucent. A rule that merely
    // omitted the old solid fill would pass a negative-only assertion while
    // leaving the active segment indistinguishable from the inactive ones.
    const bg = /background:\s*rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*(0?\.\d+)\s*\)/.exec(active);
    expect(bg).not.toBeNull();
    expect(Number(bg[1])).toBeLessThan(1);
    // The old treatment: a saturated solid fill plus white text.
    expect(active).not.toMatch(/background:\s*var\(--p-primary-color/);
    expect(active).not.toMatch(/color:\s*#fff\b/);
  });

  it("keeps the wrap behaviour a four-tab bar needs on a narrow phone", () => {
    expect(tabs).toMatch(/flex-wrap:\s*wrap/);
  });
});

describe("tab bar computed style (the rule actually reaches the element)", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    __reset();
    __responses["/touch_manager/config"] = {
      ok: true,
      allow_remote_install: true,
      is_loopback: true,
      manager_enabled: false,
      reboot_allowed: true,
      delete_allowed: true,
    };
    __responses["/touch_manager/installed"] = { ok: true, packs: [] };
  });

  it("holds the 44px touch floor the sibling packs' 32px would have broken", async () => {
    openManager();
    await flush();
    await flush();

    const segments = [...document.querySelectorAll(".tm-tab")];
    // Positive half: the segments exist at all. Without this, every assertion
    // below is vacuous over an empty list.
    expect(segments).toHaveLength(4);

    for (const seg of segments) {
      const cs = getComputedStyle(seg);
      expect(cs.minHeight).toBe("44px");
      expect(cs.minWidth).toBe("84px");
    }
  });
});
