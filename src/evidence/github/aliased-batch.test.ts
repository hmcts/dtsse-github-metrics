import { describe, expect, it } from "vitest";
import { AliasAnswer, readAliasedBatch, reaskable } from "./aliased-batch.ts";

/**
 * Reading an aliased document's answer.
 *
 * The cases that matter are the three-way ones. An alias GitHub answered, one it answered `null` for, and one it
 * never named are three different statements, and collapsing any two of them reports one of them wrongly.
 */

describe("readAliasedBatch", () => {
  it("should read an answered alias as answered, carrying the node", () => {
    const entries = readAliasedBatch("a", ["alpha"], { a0: { name: "alpha" } });

    expect(entries).toEqual([{ repository: "alpha", alias: "a0", answer: AliasAnswer.Answered, value: { name: "alpha" } }]);
  });

  it("should keep the batch's own order, so a positional alias is never read off by one", () => {
    const entries = readAliasedBatch("f", ["alpha", "beta", "gamma"], { f0: 1, f1: 2, f2: 3 });

    expect(entries.map((entry) => [entry.repository, entry.value])).toEqual([
      ["alpha", 1],
      ["beta", 2],
      ["gamma", 3]
    ]);
  });

  it("should read a null alias as null and attach the reason GitHub gave for it", () => {
    const byAlias = new Map([["a0", "FORBIDDEN: Resource not accessible by integration"]]);

    const [entry] = readAliasedBatch("a", ["alpha"], { a0: null }, byAlias);

    expect(entry?.answer).toBe(AliasAnswer.Null);
    expect(entry?.refusal).toBe("FORBIDDEN: Resource not accessible by integration");
  });

  it("should state that GitHub gave no reason rather than leaving a null alias unexplained", () => {
    // "GitHub gave no reason" is itself the answer, and a reader chasing a missing repository needs to know the
    // response held no explanation rather than that nobody looked for one.
    const [entry] = readAliasedBatch("a", ["alpha"], { a0: null });

    expect(entry?.refusal).toContain("gave no reason");
  });

  it("should read an alias the response never named as absent, in its own words", () => {
    // `null` is GitHub answering about the repository and having nothing to give; absent is the question never
    // being answered. Two statements, two sentences.
    const [entry] = readAliasedBatch("a", ["alpha"], {});

    expect(entry?.answer).toBe(AliasAnswer.Absent);
    expect(entry?.refusal).toContain("did not answer the alias");
  });

  it("should read `undefined` under a named alias as absent rather than as null", () => {
    // The distinction survives a key that is present with an undefined value, which JSON cannot produce but a
    // caller assembling a body can.
    const [entry] = readAliasedBatch("a", ["alpha"], { a0: undefined });

    expect(entry?.answer).toBe(AliasAnswer.Null);
  });

  it("should read a scalar under an alias as answered, leaving the caller's schema to refuse it", () => {
    // Whether a node is READABLE is the caller's schema's question. This one only reports whether GitHub named it.
    const [entry] = readAliasedBatch("a", ["alpha"], { a0: "not an object" });

    expect(entry?.answer).toBe(AliasAnswer.Answered);
  });

  it("should answer nothing for an empty batch", () => {
    expect(readAliasedBatch("a", [], { a0: {} })).toEqual([]);
  });
});

describe("reaskable", () => {
  const entry = (repository: string, answer: AliasAnswer) => ({ repository, alias: repository, answer });

  it("should name the unanswered repositories where at least one alias was answered", () => {
    // Then the failure is a fact about particular repositories, and asking for those on their own is worth a call.
    const entries = [entry("alpha", AliasAnswer.Answered), entry("gone", AliasAnswer.Null), entry("never", AliasAnswer.Absent)];

    expect(reaskable(entries)).toEqual(["gone", "never"]);
  });

  it("should name nothing where NO alias was answered, whatever the batch size", () => {
    // A response that answered about nothing is a credential or a query problem, and asking it again once per
    // repository would spend those calls learning the same thing.
    const entries = [entry("alpha", AliasAnswer.Null), entry("beta", AliasAnswer.Null), entry("gamma", AliasAnswer.Absent)];

    expect(reaskable(entries)).toEqual([]);
  });

  it("should name nothing for a batch of one that went unanswered, which is what stops the recursion", () => {
    expect(reaskable([entry("alpha", AliasAnswer.Null)])).toEqual([]);
  });

  it("should name nothing where every alias was answered", () => {
    expect(reaskable([entry("alpha", AliasAnswer.Answered), entry("beta", AliasAnswer.Answered)])).toEqual([]);
  });

  it("should name nothing for an empty batch", () => {
    expect(reaskable([])).toEqual([]);
  });
});
