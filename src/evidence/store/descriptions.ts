import { describedBy } from "../behaviour/collect.ts";
import { prisma } from "./prisma.ts";
import { StorageError } from "./storage-error.ts";

/**
 * Reducing the descriptions of pull requests cached BEFORE they were reduced where the fact is built.
 *
 * A ONE-OFF, and the reason it has to exist rather than being waited out. `store/facts.ts` says an old row keeps
 * its `body` "until a collection rewrites them" — but a collection only rewrites what its coverage does not
 * already claim, and `querySignature()` hashes the GraphQL document text, which did not change when the two
 * derived fields replaced the two stored ones. Settled coverage therefore stays valid and only the six-hour
 * mutable edge is refetched, so almost nothing is ever rewritten: measured on AAT, 23,854 of 24,249 rows carried
 * a `body` and a `title` and NEITHER derived field, which is `descriptionQuality` and `traceabilityReference`
 * both reading 98.4% of the estate's merges as unmeasured, and 63 MB of an 88 MB table spent on text nothing
 * reads.
 *
 * WHAT MAKES IT SAFE TO INTERLEAVE WITH A COLLECTION, so it needs no collector lock. The update derives from the
 * row's CURRENT payload — `payload - 'body' - 'title'` is evaluated by Postgres, not sent from here — so a
 * collection that rewrote the row a moment earlier keeps every field it wrote; this only removes two keys and
 * adds two. The two it adds are what a collection would have written for the same pull request, because they come
 * from the same function.
 *
 * ONE STATEMENT REMOVES THE SOURCE AND ADDS THE DERIVATION, which is the invariant worth stating plainly: a row
 * is never left holding neither its description nor the answers about it. There is no ordering of the batches, no
 * partial run and no crash that can produce a row `descriptionQuality` reads as unmeasured where it previously
 * had text to measure.
 */

/** What the table holds, before or after a run. */
export interface DescriptionCensus {
  /** Every cached pull request, whatever shape its payload is in. */
  rows: number;
  /** Rows still carrying the source text — the ones a run changes. */
  carryingDescription: number;
  /** Rows carrying both derived fields, which is what a report can measure. */
  derived: number;
  /**
   * Rows holding NEITHER any source text nor a derivation, which is the one shape this must never create.
   *
   * Expected to be zero before and after. A non-zero count is not something a run can repair — the text it would
   * have derived from is gone — so it is reported rather than acted on.
   */
  unmeasurable: number;
}

/** What one run did. */
export interface DescriptionReduction {
  /** Rows read and derived. */
  scanned: number;
  /** Rows the update actually changed, which is `scanned` unless a row was deleted underneath the read. */
  changed: number;
}

export interface ReductionOptions {
  /** Derive everything and write nothing, so an operator can see the count before the table changes. */
  dryRun: boolean;
  /** Rows per read and per update. A failure part-way leaves every earlier batch committed. */
  batchSize: number;
  /** Called after each batch, for progress on a table that takes minutes rather than seconds. */
  onBatch?: (progress: DescriptionReduction) => void;
}

/** One row's stored text, and the key that identifies it. */
interface StoredDescription {
  organization: string;
  repository: string;
  queryHash: string;
  identifier: bigint;
  title: string | null;
  body: string | null;
}

/**
 * Where a walk of the table has reached.
 *
 * The full primary key, because that is what the walk is ordered by. The FIRST batch starts from a sentinel that
 * sorts before every real row: `organization` is a non-empty name on every row ever written, and no GitHub
 * `databaseId` is negative, so `> ('', '', '', -1)` admits the whole table. That keeps one statement for every
 * batch rather than a separate one for the first.
 */
interface DescriptionCursor {
  organization: string;
  repository: string;
  queryHash: string;
  identifier: bigint;
}

const START: DescriptionCursor = { organization: "", repository: "", queryHash: "", identifier: -1n };

/** How the table divides up when no operator says otherwise. */
export const DEFAULT_BATCH_SIZE = 500;

/** The four counts, in one pass of the table. */
export async function censusOfDescriptions(): Promise<DescriptionCensus> {
  try {
    // `total` rather than `rows`, which is a reserved word Postgres would refuse as a bare alias.
    const counted = (
      await prisma.$queryRaw<{ total: bigint; carrying: bigint; derived: bigint; unmeasurable: bigint }[]>`
        SELECT count(*) AS total,
               count(*) FILTER (WHERE payload ? 'body' OR payload ? 'title') AS carrying,
               count(*) FILTER (WHERE payload ? 'bodyLength' AND payload ? 'hasTicketReference') AS derived,
               count(*) FILTER (WHERE NOT (payload ? 'body' OR payload ? 'title') AND NOT (payload ? 'bodyLength')) AS unmeasurable
        FROM pull_request_facts
      `
    )[0];
    return {
      rows: Number(counted?.total ?? 0n),
      carryingDescription: Number(counted?.carrying ?? 0n),
      derived: Number(counted?.derived ?? 0n),
      unmeasurable: Number(counted?.unmeasurable ?? 0n)
    };
  } catch (error) {
    throw new StorageError("could not read the cached descriptions", error);
  }
}

/**
 * Replaces every stored description with the two answers about it, in batches.
 *
 * WALKED BY PRIMARY KEY rather than by "the next rows that still have a body", even though the update takes each
 * batch out of that predicate. A cursor makes the walk monotonic whatever the update did, so a row the statement
 * somehow failed to reduce cannot be read again forever — and it makes the dry run, which changes nothing, take
 * exactly the same path as the real one rather than a second code path that could disagree with it.
 *
 * IDEMPOTENT TWICE OVER. A reduced row no longer matches the read at all, so a second run finds nothing; and
 * where a row somehow holds a body AND an answer already, `derived || payload` keeps the row's own answer,
 * because a stored answer was graded against the patterns of its day and this is not a regrade — see
 * `behaviour/collect.ts` on what an edited pattern list does and does not touch.
 */
export async function reduceStoredDescriptions(patterns: readonly RegExp[], options: ReductionOptions): Promise<DescriptionReduction> {
  let cursor = START;
  const progress: DescriptionReduction = { scanned: 0, changed: 0 };

  for (;;) {
    const batch = await readDescriptions(cursor, options.batchSize);
    if (batch.length === 0) {
      return progress;
    }

    progress.scanned += batch.length;
    if (!options.dryRun) {
      progress.changed += await writeAnswers(batch, patterns);
    }

    const last = batch[batch.length - 1] as StoredDescription;
    cursor = { organization: last.organization, repository: last.repository, queryHash: last.queryHash, identifier: last.identifier };
    options.onBatch?.({ ...progress });
  }
}

/** One batch of rows still carrying their text, in primary-key order from the cursor. */
async function readDescriptions(cursor: DescriptionCursor, batchSize: number): Promise<StoredDescription[]> {
  try {
    // `->>` gives NULL both for an absent key and for a JSON null, which `describedBy` reads as the empty string
    // either way — the same answer GitHub's own null body produces, and a length of zero rather than no length.
    return await prisma.$queryRaw<StoredDescription[]>`
      SELECT organization, repository, query_hash AS "queryHash", identifier,
             payload->>'title' AS title, payload->>'body' AS body
      FROM pull_request_facts
      WHERE (payload ? 'body' OR payload ? 'title')
        AND (organization, repository, query_hash, identifier) >
            (${cursor.organization}::text, ${cursor.repository}::text, ${cursor.queryHash}::text, ${cursor.identifier.toString()}::bigint)
      ORDER BY organization, repository, query_hash, identifier
      LIMIT ${batchSize}
    `;
  } catch (error) {
    throw new StorageError("could not read the cached descriptions", error);
  }
}

/**
 * Adds the answers and removes the text, one statement for the batch.
 *
 * THE ARRAYS TRAVEL THROUGH `unnest`, as they do in `facts.ts`: five bind parameters however many rows a batch
 * holds, so no batch size can meet PostgreSQL's 65,535-parameter ceiling.
 *
 * `derived || payload` and not the other way around, so the ROW's own answers win where it has any. The `- 'body'
 * - 'title'` is applied to the row's payload as Postgres reads it, which is what makes a concurrent collection
 * harmless: nothing this sends can overwrite a field the collection wrote.
 */
async function writeAnswers(batch: readonly StoredDescription[], patterns: readonly RegExp[]): Promise<number> {
  const answers = batch.map((row) => JSON.stringify(describedBy(row, patterns)));
  try {
    return await prisma.$executeRaw`
      UPDATE pull_request_facts AS fact
      SET payload = derived.payload::jsonb || (fact.payload - 'body' - 'title')
      FROM unnest(
        ${batch.map((row) => row.organization)}::text[],
        ${batch.map((row) => row.repository)}::text[],
        ${batch.map((row) => row.queryHash)}::text[],
        ${batch.map((row) => row.identifier.toString())}::text[],
        ${answers}::text[]
      ) AS derived(organization, repository, query_hash, identifier, payload)
      WHERE fact.organization = derived.organization
        AND fact.repository = derived.repository
        AND fact.query_hash = derived.query_hash
        AND fact.identifier = derived.identifier::bigint
    `;
  } catch (error) {
    throw new StorageError("could not reduce the cached descriptions", error);
  }
}
