import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { slotErrors } from "../skill/agent-readiness/scripts/lib/model.ts";
import type { Audit } from "../skill/agent-readiness/scripts/lib/types.ts";
import { choicesFor, makeAudit, reportFor } from "./helpers.ts";

// Two components hold the repo at Level 1 for different reasons; web is at Level 2.
function level1(): Audit {
  return makeAudit({ components: [{ id: "api", share: 0.5, lint: "fail", faults: "pass" }, { id: "worker", share: 0.4, faults: "fail" }, { id: "web", share: 0.1, faults: "pass" }] });
}

const idOf = (a: Audit, component: string, condition: string) => a.evidence.find((e) => e.component === component && e.condition === condition)!.id;

describe("narration slots", () => {
  test("the choices are ids from the model: the components that set the level, their failures, passing steps and part 1's items", () => {
    const a = level1();
    const ch = choicesFor(a);
    assert.deepEqual(ch.lead, ["api", "worker"]);
    assert.deepEqual(ch.cause.map((c) => `${c.component} ${c.condition}=${c.evidence}`), [`api commands=${idOf(a, "api", "commands")}`, `worker faults=${idOf(a, "worker", "faults")}`]);
    assert.ok(ch.works.some((w) => w.evidence === idOf(a, "api", "clean.test") && w.says === "api passes its tests in a clean container"));
    assert.ok(ch.works.some((w) => w.says === "the repo installs in a clean container"));
    assert.ok(!ch.works.some((w) => w.evidence === idOf(a, "api", "commands")), "a failing step is never offered as working");
    assert.deepEqual(ch.ask.map((x) => x.id), reportFor(a).actions.map((x) => x.itemId));
  });

  test("lead names its component first, and cause puts its condition first", () => {
    const a = level1();
    assert.match(reportFor(a).executive.headline, /^Agents can build and test api and worker, but their lint command fails and their tests can't yet catch wrong changes/);
    a.narration = { lead: "worker", cause: { condition: "faults", evidence: idOf(a, "worker", "faults") } };
    assert.match(reportFor(a).executive.headline, /^Agents can build and test worker and api, but their tests can't yet catch wrong changes and their lint command fails/);
  });

  test("works adds what already passes, and is left out when it would overrun the word limit", () => {
    const a = level1();
    a.narration = { works: [idOf(a, "api", "clean.test"), a.evidence.find((e) => e.kind === "install")!.id] };
    assert.match(reportFor(a).executive.headline, / Already passing: api passes its tests in a clean container; the repo installs in a clean container\.$/);
    const many = makeAudit({ components: ["alpha-service", "bravo-service", "charlie-service"].map((id) => ({ id, share: 0.3, lint: "fail" as const, faults: "fail" as const })) });
    many.narration = { works: many.evidence.filter((e) => e.result === "pass").map((e) => e.id) };
    assert.doesNotMatch(reportFor(many).executive.headline, /Already passing/);
  });

  test("ask picks part 1's decision from a roadmap item, or settle for what settles an undetermined level", () => {
    const a = level1();
    const second = reportFor(a).actions[1];
    a.narration = { ask: second.itemId };
    assert.match(reportFor(a).executive.ask, /^Decision needed: /);
    assert.notEqual(reportFor(a).executive.ask, reportFor(level1()).executive.ask);
    const u = makeAudit({ components: [{ id: "app", share: 1, test: "missing" }] });
    const r = reportFor(u);
    assert.equal(r.maturity.status, "undetermined");
    assert.ok(choicesFor(u).ask.some((x) => x.id === "settle"));
    u.narration = { ask: "settle" };
    assert.match(reportFor(u).executive.ask, /^Decision needed: who settles Level 1 for app: add the command the repo runs app's tests with, readiness contract add --kind test --component app --cmd "<command>", and rerun the audit\./);
  });

  test("an id that isn't a choice is refused by name with the choices, and the report keeps its default", () => {
    const a = level1();
    const ch = choicesFor(a);
    const bad = { headline: "api is fine", lead: "web", cause: { condition: "faults", evidence: idOf(a, "api", "commands") }, works: ["ev-999"], ask: "nope" } as unknown as Audit["narration"];
    const errors = slotErrors(bad, ch);
    assert.equal(errors.length, 5, errors.join("\n"));
    assert.match(errors[0], /sets "headline", which isn't a slot/);
    assert.match(errors[1], /lead web isn't a component that sets the level \(choices: api, worker\)/);
    assert.match(errors[2], /cause faults=ev-\d+ isn't a cause the headline can give/);
    assert.match(errors[3], /works ev-999 isn't a step that passed/);
    assert.match(errors[4], /ask nope isn't an item part 1 can ask about/);
    a.narration = bad;
    const r = reportFor(a);
    const plain = reportFor(level1());
    assert.deepEqual([r.executive.headline, r.executive.ask], [plain.executive.headline, plain.executive.ask]);
    assert.deepEqual(slotErrors({ lead: "api", cause: { condition: "commands", evidence: idOf(a, "api", "commands") }, ask: plain.actions[0].itemId }, ch), []);
  });
});
