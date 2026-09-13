import { describe, expect, it } from "vitest";
import { factStatement, factText, normalizeTopic, planFacts, type CurrentFact, type FactCandidate } from "../src/facts";

describe("normalizeTopic", () => {
  it("folds case, spacing and punctuation so equivalent topics compare equal", () => {
    expect(normalizeTopic("Clinic Hours")).toBe(normalizeTopic("clinic-hours"));
    expect(normalizeTopic("Clinic  Hours!")).toBe(normalizeTopic("clinic hours"));
  });

  it("leaves Chinese topics alone besides trimming and punctuation", () => {
    expect(normalizeTopic("诊所营业时间。")).toBe(normalizeTopic("诊所营业时间"));
  });

  it("distinct topics stay distinct", () => {
    expect(normalizeTopic("clinic hours")).not.toBe(normalizeTopic("workshop venue"));
  });
});

describe("planFacts", () => {
  const noCurrent = new Map<string, CurrentFact>();

  it("a brand-new topic is planned with no supersede", () => {
    const candidates: FactCandidate[] = [{ topic: "clinic hours", statement: "Open 9-5 weekdays." }];
    const plan = planFacts(candidates, noCurrent, (i) => `fact:m1:${i}`);
    expect(plan).toEqual([{ id: "fact:m1:0", topic: "clinic hours", statement: "Open 9-5 weekdays.", supersedes: null }]);
  });

  it("a topic that already has a current fact supersedes it", () => {
    const currentByTopic = new Map<string, CurrentFact>([[normalizeTopic("clinic hours"), { id: "fact:m0:0" }]]);
    const candidates: FactCandidate[] = [{ topic: "Clinic Hours", statement: "Open 9-5 weekdays, and Saturdays 10-2." }];
    const plan = planFacts(candidates, currentByTopic, (i) => `fact:m1:${i}`);
    expect(plan).toEqual([{ id: "fact:m1:0", topic: "Clinic Hours", statement: "Open 9-5 weekdays, and Saturdays 10-2.", supersedes: "fact:m0:0" }]);
  });

  it("matches an existing topic despite different casing or punctuation", () => {
    const currentByTopic = new Map<string, CurrentFact>([[normalizeTopic("Workshop Venue"), { id: "fact:m0:3" }]]);
    const candidates: FactCandidate[] = [{ topic: "workshop-venue", statement: "Now at the downtown library." }];
    const plan = planFacts(candidates, currentByTopic, (i) => `fact:m2:${i}`);
    expect(plan[0]?.supersedes).toBe("fact:m0:3");
  });

  it("a topic with no current fact does not supersede an unrelated one", () => {
    const currentByTopic = new Map<string, CurrentFact>([[normalizeTopic("clinic hours"), { id: "fact:m0:0" }]]);
    const candidates: FactCandidate[] = [{ topic: "workshop venue", statement: "Downtown library." }];
    const plan = planFacts(candidates, currentByTopic, (i) => `fact:m1:${i}`);
    expect(plan[0]?.supersedes).toBeNull();
  });

  it("repeats the same topic within one meeting's facts: the last statement wins, one row is planned", () => {
    const candidates: FactCandidate[] = [
      { topic: "clinic hours", statement: "Open 9-5 weekdays." },
      { topic: "Clinic Hours", statement: "Open 9-5 weekdays, and Saturdays 10-2." }
    ];
    const plan = planFacts(candidates, noCurrent, (i) => `fact:m1:${i}`);
    expect(plan).toHaveLength(1);
    expect(plan[0]?.statement).toBe("Open 9-5 weekdays, and Saturdays 10-2.");
  });

  it("drops candidates with an empty topic or statement", () => {
    const candidates: FactCandidate[] = [
      { topic: "  ", statement: "Open 9-5." },
      { topic: "clinic hours", statement: "   " },
      { topic: "workshop venue", statement: "Downtown library." }
    ];
    const plan = planFacts(candidates, noCurrent, (i) => `fact:m1:${i}`);
    expect(plan.map((item) => item.topic)).toEqual(["workshop venue"]);
  });

  it("several distinct topics in one meeting each get their own id and can each supersede a different current fact", () => {
    const currentByTopic = new Map<string, CurrentFact>([
      [normalizeTopic("clinic hours"), { id: "fact:m0:0" }],
      [normalizeTopic("workshop venue"), { id: "fact:m0:1" }]
    ]);
    const candidates: FactCandidate[] = [
      { topic: "clinic hours", statement: "Open 9-5 weekdays, and Saturdays 10-2." },
      { topic: "workshop venue", statement: "Now at the downtown library." },
      { topic: "referral fee", statement: "10% to whoever refers a new client." }
    ];
    const plan = planFacts(candidates, currentByTopic, (i) => `fact:m1:${i}`);
    expect(plan).toHaveLength(3);
    expect(plan.find((item) => item.topic === "clinic hours")?.supersedes).toBe("fact:m0:0");
    expect(plan.find((item) => item.topic === "workshop venue")?.supersedes).toBe("fact:m0:1");
    expect(plan.find((item) => item.topic === "referral fee")?.supersedes).toBeNull();
  });
});

describe("factText / factStatement", () => {
  it("round-trips: stripping the appended provenance line recovers the original statement", () => {
    const text = factText("Open 9-5 weekdays.", "Weekly planning", "2026-09-13");
    expect(text).toBe("Open 9-5 weekdays.\nFrom: Weekly planning, 2026-09-13");
    expect(factStatement(text)).toBe("Open 9-5 weekdays.");
  });

  it("leaves a statement with no provenance line untouched", () => {
    expect(factStatement("Open 9-5 weekdays.")).toBe("Open 9-5 weekdays.");
  });

  it("only strips a trailing From: line, not one that happens to appear mid-statement", () => {
    const text = "Quoted someone saying \"From: nowhere\" earlier.\nFrom: Weekly planning, 2026-09-13";
    expect(factStatement(text)).toBe('Quoted someone saying "From: nowhere" earlier.');
  });
});
