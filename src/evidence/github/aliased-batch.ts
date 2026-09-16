/**
 * Reading an aliased GraphQL document's answer, one alias per repository.
 *
 * Two readers here batch repositories into one document — the assurance signals and the CODEOWNERS walk — and
 * both had the same shape of bug: GitHub answers a document naming one unreadable repository with HTTP 200,
 * the aliases it could resolve, a `null` for the one it could not and an `errors` array saying why, and the
 * client threw the whole thing away. This is the half of the fix that is not the client's: given the data and
 * the errors, which repositories were answered, which were refused, and which of those are worth asking for
 * again on their own.
 *
 * KEPT IN ONE PLACE because the two readers had already drifted. One recorded a null alias as a refusal and
 * the other as an absence, and only one of them was right.
 */

/**
 * What one alias answered for the repository it was asked under. THREE OUTCOMES, and none of them collapse.
 *
 * `Answered` and `Null` are both GitHub answering. `Absent` is GitHub not naming the alias at all, which is a
 * different statement: `null` means it answered about that repository and had nothing to give, and absent
 * means the question was never answered. A reader that treats them alike reports one of them wrongly —
 * whichever way round it chooses.
 */
export const AliasAnswer = {
  Answered: "answered",
  Null: "null",
  Absent: "absent"
} as const;

export type AliasAnswer = (typeof AliasAnswer)[keyof typeof AliasAnswer];

/** One repository's place in a batched answer. */
export interface AliasedEntry {
  repository: string;
  /** The alias it was asked under, which is also the key GitHub reports an error at. */
  alias: string;
  answer: AliasAnswer;
  /** The node, present only for `Answered`. */
  value?: unknown;
  /** Why there is no node, for `Null` and `Absent`. Always a sentence, never an empty string. */
  refusal?: string;
}

/**
 * What GitHub said about a `null` alias it named no error for.
 *
 * Reported rather than left blank, because "GitHub gave no reason" is itself the answer and a reader chasing a
 * missing repository needs to know that the response held no explanation rather than that nobody looked for one.
 */
const NO_STATED_REASON = "GitHub named no repository for the alias it was asked under and gave no reason";

/** What GitHub said about an alias it did not name at all. */
const NOT_NAMED = "GitHub did not answer the alias this repository was asked under";

/**
 * Every repository's place in one batched answer, in the order they were asked for.
 *
 * `byAlias` is the client's map of alias to GitHub's own `TYPE: message`, so a `null` node carries the reason
 * GitHub gave for it — `FORBIDDEN: Resource not accessible by integration` and a repository that was archived
 * and transferred are different answers, and a reader told only that the node was null cannot tell which they
 * got. Where GitHub named no error for a null alias, that absence of a reason is stated too.
 */
export function readAliasedBatch(
  prefix: string,
  batch: readonly string[],
  data: Record<string, unknown>,
  byAlias: ReadonlyMap<string, string> = new Map()
): AliasedEntry[] {
  return batch.map((repository, index) => {
    const alias = `${prefix}${index}`;
    if (!(alias in data)) {
      return { repository, alias, answer: AliasAnswer.Absent, refusal: NOT_NAMED };
    }
    const value = data[alias];
    if (value == null) {
      return { repository, alias, answer: AliasAnswer.Null, refusal: byAlias.get(alias) ?? NO_STATED_REASON };
    }
    return { repository, alias, answer: AliasAnswer.Answered, value };
  });
}

/**
 * The repositories worth asking for again ON THEIR OWN, which is not simply the ones that went unanswered.
 *
 * ONE RULE, and it does two jobs. A batch is re-asked one repository at a time only where AT LEAST ONE alias
 * in it was answered, because that is what makes the failure a fact about particular repositories rather than
 * about the document: a response that answered about nothing is a credential or a query problem, and asking it
 * again fifty times over would spend fifty calls learning the same thing. The same rule is what stops the
 * recursion — a batch of one that went unanswered has no answered alias, so it never splits further.
 */
export function reaskable(entries: readonly AliasedEntry[]): string[] {
  if (!entries.some((entry) => entry.answer === AliasAnswer.Answered)) {
    return [];
  }
  return entries.filter((entry) => entry.answer !== AliasAnswer.Answered).map((entry) => entry.repository);
}
