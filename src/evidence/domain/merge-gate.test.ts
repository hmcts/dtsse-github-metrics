import { describe, expect, it } from "vitest";
import { mergeGateWithoutRuleDetails } from "../inventory/merge-gate.ts";
import { mergeGateReport } from "./merge-gate.ts";

describe("mergeGateReport", () => {
  const gate = mergeGateWithoutRuleDetails("main", { protected: false, rulesObserved: true });

  it("should accept a report carrying a gate", () => {
    expect(mergeGateReport({ gate })).toEqual({ gate });
  });

  it("should accept a report carrying the reason there is no gate", () => {
    expect(mergeGateReport({ detail: "refused" })).toEqual({ detail: "refused" });
  });

  it.each([[{}], [{ gate, detail: "refused" }]])("should refuse %o, which carries neither or both", (report) => {
    expect(() => mergeGateReport(report)).toThrow(RangeError);
  });
});
