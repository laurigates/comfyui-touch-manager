// @vitest-environment jsdom
//
// The delete-gate explanation: a dismissible callout, and a Settings mirror.
//
// The string used to render as `tm-row-meta tm-gate-note` — 13px at 75%
// opacity, between a button and the sweep label — for a three-sentence
// instruction about setting a server env var. `.tm-gate-note` carried no CSS
// of its own, so it inherited the meta treatment alone and read as chrome.
//
// Tier notes (.claude/rules/modal-pack-test-tiers.md):
//   - The note treatment lives in the injected stylesheet, never inline, so
//     every style assertion below goes through getComputedStyle. An
//     `el.style.background` read here would be vacuous.
//   - Whether the ✕ measures 44px on glass is a browser-tier question; jsdom
//     can only confirm the rule resolves onto the element.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deleteGateStatusText } from "../../src/manager-core.ts";
import {
  __resetGateNag,
  deleteGateStatusElement,
  openManager,
} from "../../src/touch-manager-ui.ts";
import { __registered, __reset, __responses } from "./__mocks__/app.js";

const flush = () => new Promise((r) => setTimeout(r, 0));
const settle = async (n = 6) => {
  for (let i = 0; i < n; i++) await flush();
};

const REFUSING = {
  ok: true,
  allow_remote_install: false,
  is_loopback: false,
  manager_enabled: false,
  reboot_allowed: false,
  delete_allowed: false,
};
const PERMITTING = { ...REFUSING, is_loopback: true, delete_allowed: true };

const gitPack = (name) => ({
  name,
  path: `/x/${name}`,
  root: "/x",
  is_git: true,
  ref: { type: "branch", name: "main", sha: "abc1234" },
  remote_url: `https://github.com/laurigates/${name}`,
  dirty: false,
  enabled: true,
});

const note = () => document.querySelector(".tm-gate-note");

describe("delete-gate callout", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    __reset();
    __resetGateNag();
    __responses["/touch_manager/config"] = REFUSING;
    __responses["/touch_manager/installed"] = { ok: true, packs: [gitPack("safe-pack")] };
    __responses["/touch_manager/updates/list"] = { ok: true, packs: [] };
  });

  it("renders as the warn-callout treatment, not as muted meta text", async () => {
    openManager();
    await settle();

    const callout = note();
    expect(callout).toBeTruthy();
    expect(callout.textContent).toContain("TOUCH_MANAGER_ALLOW_REMOTE_DELETE=1");

    // The treatment, resolved through the injected sheet. `.tm-note-warn` is
    // the amber callout the install and switch-repo gates already use.
    const cs = getComputedStyle(callout);
    expect(cs.backgroundColor).toBe("rgba(180, 140, 20, 0.18)");
    expect(cs.borderTopWidth).toBe("1px");
    expect(cs.borderTopStyle).toBe("solid");

    // Two-sided against the treatment it USED to have: the sweep label is the
    // sibling that is still plain meta text. Without this the assertions above
    // would also pass if `.tm-note-warn` had leaked onto everything.
    const sweep = document.querySelector(".tm-sweep-label");
    expect(sweep).toBeTruthy();
    expect(getComputedStyle(sweep).backgroundColor).not.toBe("rgba(180, 140, 20, 0.18)");
    // ...and the callout is no longer wearing the meta treatment itself.
    expect(callout.classList.contains("tm-row-meta")).toBe(false);
    expect(cs.opacity).toBe("1");
  });

  it("is present, then gone after the dismiss control is tapped", async () => {
    openManager();
    await settle();

    // Present half — stated in the same test, because "dismissing removes it"
    // is trivially satisfied by a callout that never rendered.
    expect(note()).toBeTruthy();

    const dismiss = document.querySelector(".tm-gate-dismiss");
    expect(dismiss).toBeTruthy();
    // The ✕ is a real control at the family touch floor.
    const ds = getComputedStyle(dismiss);
    expect(ds.minHeight).toBe("44px");
    expect(ds.minWidth).toBe("44px");

    dismiss.click();
    await settle();
    expect(note()).toBeFalsy();
  });

  it("stays dismissed across modal opens while the gate state is unchanged", async () => {
    openManager();
    await settle();
    document.querySelector(".tm-gate-dismiss").click();
    await settle();

    // Re-open against the SAME config. Re-nagging every open is the noise the
    // dismissal exists to stop.
    document.body.replaceChildren();
    openManager();
    await settle();
    expect(note()).toBeFalsy();
    // Positive control: the modal really did render, so "no callout" is a
    // fact about the callout and not about an empty document.
    expect(document.body.textContent).toContain("safe-pack");
  });

  it("speaks again when the gate is enabled and then refuses once more", async () => {
    // Why the dismissal is keyed on gate STATE and not a bare boolean: a
    // dismissal answers one refusal, and a server restarted with the override
    // on and then off again is a new one.
    openManager();
    await settle();
    document.querySelector(".tm-gate-dismiss").click();
    await settle();
    expect(note()).toBeFalsy();

    // Gate opens — nothing to say.
    __responses["/touch_manager/config"] = PERMITTING;
    document.body.replaceChildren();
    openManager();
    await settle();
    expect(note()).toBeFalsy();

    // Gate closes again — a fresh refusal, so it speaks.
    __responses["/touch_manager/config"] = REFUSING;
    document.body.replaceChildren();
    openManager();
    await settle();
    expect(note()).toBeTruthy();
  });
});

describe("delete-gate status in Settings", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    __reset();
  });

  it("reads the live gate in both directions, never a stored value", () => {
    // Two-sided on the same helper: a text function hard-wired to either
    // string passes only one of these.
    expect(deleteGateStatusText(PERMITTING)).toContain("Enabled");
    expect(
      deleteGateStatusText({ ...REFUSING, is_loopback: false, delete_allowed: true }),
    ).toContain("TOUCH_MANAGER_ALLOW_REMOTE_DELETE=1 is set");
    expect(deleteGateStatusText(REFUSING)).toContain("not bound to loopback");
    expect(deleteGateStatusText(REFUSING)).toContain("TOUCH_MANAGER_ALLOW_REMOTE_DELETE=1");
    expect(deleteGateStatusText(null)).toContain("Unavailable");
  });

  it("paints the renderer from GET /touch_manager/config, not from a setting", async () => {
    __responses["/touch_manager/config"] = REFUSING;
    const refused = deleteGateStatusElement();
    await settle();
    expect(refused.textContent).toBe(deleteGateStatusText(REFUSING));

    // Same renderer, different backend answer → different text. This is what
    // separates "reads the backend" from "prints a constant".
    __responses["/touch_manager/config"] = PERMITTING;
    const allowed = deleteGateStatusElement();
    await settle();
    expect(allowed.textContent).toBe(deleteGateStatusText(PERMITTING));
    expect(allowed.textContent).not.toBe(refused.textContent);
  });

  it("degrades to a readable line when the backend cannot be reached", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    __responses["/touch_manager/config"] = { ok: false, error: "nope" };
    const el = deleteGateStatusElement();
    await settle();
    expect(el.textContent).toBe(deleteGateStatusText(null));
    warn.mockRestore();
  });

  it("registers a second Touch Node Manager setting with a distinct category leaf", async () => {
    // Importing src/index.ts runs the registration side effect against the
    // mock, exactly as sidebar-tab.test.js does.
    await import("../../src/index.ts");
    const settings = __registered.at(-1)?.settings ?? [];
    const ours = settings.filter((s) => s.category?.[1] === "Touch Node Manager");
    expect(ours).toHaveLength(2);

    // The load-bearing constraint: two settings sharing an identical FULL
    // category array collapse into one in the dialog (buildTree overwrites
    // parent.data), so the third element must differ.
    const leaves = ours.map((s) => s.category[2]);
    expect(new Set(leaves).size).toBe(2);
    expect(leaves).toContain("Remote delete");

    const status = ours.find((s) => s.category[2] === "Remote delete");
    expect(status.tooltip).toContain("TOUCH_MANAGER_ALLOW_REMOTE_DELETE");
    // A custom renderer rather than a stored type — the whole point of the
    // entry. A string type here would mean a stored value that can disagree
    // with the backend.
    expect(typeof status.type).toBe("function");
  });
});
