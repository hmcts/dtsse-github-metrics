import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { AssessmentSection } from "@/components/AssessmentSection";
import { ContributorsTable } from "@/components/ContributorsTable";
import { DefinitionList } from "@/components/DefinitionList";
import { EmptyState } from "@/components/EmptyState";
import { EntityHeader } from "@/components/EntityHeader";
import { FindingsTable } from "@/components/FindingsTable";
import { MetricCard } from "@/components/MetricCard";
import { MetricsGrid } from "@/components/MetricsGrid";
import { NavWeekSelector } from "@/components/NavWeekSelector";
import { OwnerName } from "@/components/OwnerName";
import { RepositoryNotes } from "@/components/RepositoryNotes";
import { Panel, Section, SectionPair } from "@/components/Section";
import { TrendSection } from "@/components/TrendSection";
import { getRepository, getRepositoryNotes, getTrend, getWindows, isNotFound } from "@/lib/api";
import { instant, span } from "@/lib/format";
import {
  codeownersCard,
  cohortCards,
  type LabelledValue,
  maintenanceRows,
  maintenanceSummary,
  mergeGateRows,
  openPullRequestCards,
  securityCards,
  sonarGateCard,
  sonarRows
} from "@/lib/repository";
import type { RepositoryDetail, SonarReport } from "@/lib/types";
import { resolveWeeks, type SearchValue, WEEKS_COOKIE } from "@/lib/weeks";
import { createNote, deleteNote, editNote } from "./notes";

/**
 * One repository's whole evidence block at one window span.
 *
 * The page is the block, and mostly in the block's own order: the cohort it was all measured over,
 * then each collected signal, the findings, and who authored the window. Two departures, and only
 * two. Behaviour and readiness are SWAPPED: the metrics sit directly under the cohort row and the
 * policy's blocking, caution and clear groups follow them, because a reader wants the figures before
 * the grading drawn from them. And inside the clear group, `repository.gradedFirst` sinks the
 * informational rows below the graded ones, for the reason its own comment gives — no condition
 * moves between groups, and the policy's order survives inside each half of that one.
 *
 * Nothing is recomputed here — every figure is one the service
 * sent, formatted by `lib/repository.ts` — so the page and `metrics evidence` for the same span are
 * one claim rather than two that can drift.
 *
 * A repository the span cannot be reported for keeps its page and says why. It is a configured
 * repository either way, and a 404 for one would read as a repository nobody has heard of.
 */
export const dynamic = "force-dynamic";

export default async function RepositoryPage({
  params,
  searchParams
}: {
  params: Promise<{ repository: string }>;
  searchParams?: Promise<{ weeks?: SearchValue }>;
}) {
  const windows = await getWindows();
  const weeks = resolveWeeks((await searchParams)?.weeks, (await cookies()).get(WEEKS_COOKIE)?.value, windows.options, windows.default);
  const detail = await readRepository((await params).repository, weeks);
  const evidence = detail.evidence;

  // READ BEFORE THE NO-EVIDENCE BRANCH, and drawn on both sides of it. A note is not a fact about a reporting
  // window — "this is being decommissioned" is exactly the kind of thing written about a repository that has
  // stopped producing evidence — so a span with nothing in it is the last page a reader should be denied the
  // notes on. It is one indexed query against a small table, on a page that already makes several.
  const notes = (
    <Section heading="Notes" detail="oldest first">
      <RepositoryNotes
        repository={detail.repository}
        notes={await getRepositoryNotes(detail.repository)}
        create={createNote}
        edit={editNote}
        remove={deleteNote}
      />
    </Section>
  );

  const header = (
    <EntityHeader
      kind="repository"
      name={detail.repository}
      href={detail.url}
      label={evidence?.assessment?.label}
      // Not read from the window, so it survives the unavailable branch below: a repository this
      // span cannot report is still or is still not a production service.
      production={detail.production}
      action={<NavWeekSelector options={windows.options} active={weeks} />}
      context={
        <>
          {/* The same owner rule the estate table follows: a person is named and marked rather than
              linked, because `/teams` lists teams and there is no page for one. */}
          <OwnerName row={detail} weeks={weeks} />
          {evidence ? <span>{span(evidence.starts_at, evidence.ends_at)}</span> : null}
          {/* provenance.intervals_fetched is deliberately not rendered: how many intervals the
              collector had to fetch rather than reuse is a caching detail, and "0 intervals fetched"
              reads to a reader as missing data. The field stays in the contract. */}
        </>
      }
    />
  );

  if (evidence === undefined) {
    return (
      <div className="space-y-8">
        {header}
        <EmptyState
          message={`This span holds no evidence for ${detail.repository}.`}
          detail={`${detail.detail ?? "no reason was given"} — run metrics collect for the span being asked for, or read the repository at a span the caches cover.`}
        />
        {notes}
      </div>
    );
  }

  const findings = evidence.behaviour;
  const alerts = evidence.security.alerts;
  const openPullRequests = openPullRequestCards(evidence.open_pull_requests);
  // Read after the unavailable branch above: a series is cut from the caches per period, which is
  // work worth doing only for a page that is going to draw the rest of the block too.
  //
  // Cut to the count the service publishes, so a long-enabled repository is served a bounded series
  // rather than refused one. The section says when a series sits at that cut, because the periods it
  // holds then are the first ones since enablement and not the whole history.
  //
  // The ONLY fetch on this page that is allowed to fail quietly. The trend is one section of a page
  // whose evidence has already arrived, and the section already renders only when the endpoint
  // returns periods — an observation history that could not be read should cost the reader that
  // section and not the whole page.
  const series = await getTrend(detail.repository, windows.trend_periods).catch(() => null);

  return (
    <div className="space-y-8">
      {header}

      {/* The cohort is the page's headline figure rather than a section of it, so it carries the
          panel without a heading: the cards are flat, and four unbounded figures would float.

          The three cohort cards come from `lib/repository` rather than being written here, so an
          unread merge history reads as a dash and its reason on this page exactly as it does in the
          estate table's Merged column. */}
      <Panel>
        <div className="p-4">
          <ValueCards values={[...cohortCards(evidence.cohort), codeownersCard(evidence.codeowners)]} />
        </div>
      </Panel>

      {/* Above the assessment on purpose: these are the measurements the policy graded, and a
          reader takes the verdict better having read the figures it was drawn from. */}
      <Section heading="Behaviour" detail={span(evidence.starts_at, evidence.ends_at)}>
        <MetricsGrid summaries={evidence.metrics} empty="No behaviour metric was computed for this repository at this span." assessment={evidence.assessment} />
      </Section>

      {evidence.assessment ? (
        <AssessmentSection assessment={evidence.assessment} />
      ) : (
        <Section heading="Readiness">
          <EmptyState
            message="The readiness policy graded nothing for this repository at this span."
            detail="A repository with no eligible merges is not graded, which is not the same as being graded and passing."
          />
        </Section>
      )}

      {/* The gate is what open pull requests have to pass, so the rules and the queue are read as
          one thing rather than a screen apart. */}
      <SectionPair>
        <Section heading="Merge gate" detail={read(evidence.merge_gate.fetched_at)}>
          {evidence.merge_gate.gate === undefined ? (
            <EmptyState message="The merge gate could not be read for this repository." detail={evidence.merge_gate.detail} />
          ) : (
            <DefinitionList values={mergeGateRows(evidence.merge_gate.gate)} />
          )}
        </Section>

        <Section heading="Open pull requests" detail={read(evidence.open_pull_requests.fetched_at)}>
          {openPullRequests.length === 0 ? (
            <EmptyState message="Open pull-request state was not collected for this repository." detail={evidence.open_pull_requests.detail} />
          ) : (
            // Two across rather than the four the full width allowed: in half a row, four counts
            // are four cramped columns, and two rows of two keep each figure at headline size.
            <ValueCards values={openPullRequests} columns={2} />
          )}
        </Section>
      </SectionPair>

      {/* An open alert and the maintenance window that would have patched it are the same question
          asked twice, which is why they sit together. */}
      <SectionPair>
        <Section heading="Security alerts" detail={read(evidence.security.fetched_at)}>
          {alerts === undefined ? (
            <EmptyState message="No security alert family could be read for this repository." detail={evidence.security.detail} />
          ) : (
            <DefinitionList values={securityCards(alerts)} />
          )}
        </Section>

        <Section heading="Maintenance" detail={maintenanceSummary(evidence.maintenance)}>
          {evidence.maintenance.windows.length === 0 ? (
            <EmptyState message="No maintenance window was checked for this repository." />
          ) : (
            <DefinitionList values={maintenanceRows(evidence.maintenance)} />
          )}
        </Section>
      </SectionPair>

      <Section heading="SonarCloud" detail={read(evidence.sonar.fetched_at)}>
        <ValueCards values={[sonarGateCard(evidence.sonar), ...sonarMeasures(evidence.sonar)]} />
      </Section>

      {/* Drawn whenever a series ARRIVED, periods or not: `TrendSection` says why a repository has none,
          which distinguishes one enabled too recently from one with no enablement date configured. A
          refused fetch is the one case that draws nothing, because then there is no reason to give. */}
      {series === null ? null : <TrendSection series={series} cut={windows.trend_periods} />}

      <Section heading="Findings" detail="by rule, then alphabetical by contributor">
        {findings.length === 0 ? (
          <EmptyState message="No practice rule fired on this repository at this span." />
        ) : (
          <FindingsTable findings={findings} weeks={weeks} />
        )}
      </Section>

      <Section heading="Contributors" detail="weightiest share of this span first">
        {detail.contributors.length === 0 ? (
          <EmptyState message="Nobody authored a reported merge in this repository at this span." />
        ) : (
          <ContributorsTable rows={detail.contributors} weeks={weeks} />
        )}
      </Section>

      {/* LAST, below every collected signal. Everything above is evidence this service gathered; this is what
          a person wants to say about it, which reads as a footnote to the block rather than a preface. */}
      {notes}
    </div>
  );
}

/**
 * Read one repository, answering not-found for a name the configuration does not hold.
 *
 * Only a 404 becomes a not-found page: every other refusal is a fault in the service or the network
 * and is left to surface as one, rather than being disguised as a repository that does not exist.
 */
async function readRepository(repository: string, weeks: number): Promise<RepositoryDetail> {
  try {
    return await getRepository(repository, weeks);
  } catch (error) {
    if (isNotFound(error)) {
      notFound();
    }
    throw error;
  }
}

/** When a stored block was read, for a section heading, or nothing where nothing was collected. */
function read(fetched: string | undefined): string | undefined {
  return fetched === undefined ? undefined : `read ${instant(fetched)}`;
}

/** The measures behind a Sonar gate, or no cards at all where the project reported none. */
function sonarMeasures(report: SonarReport): LabelledValue[] {
  return report.measures === undefined ? [] : sonarRows(report.measures);
}

/**
 * A row of labelled figures, for the blocks whose figures are what the reader came for.
 *
 * The cohort row, the four open pull-request counts and the Sonar measures — a number each, worth
 * headline size. The merge gate, the maintenance windows and the alert families are drawn as
 * `DefinitionList`s instead: they are settings and their answers, and eighteen two-word answers
 * across a four-across grid read as a field of cards rather than as three blocks.
 *
 * The tone rides on the row rather than being decided here, so the threshold behind a colour is in
 * `lib/tone.ts` where a test can reach it and this stays the page drawing what it was handed.
 *
 * `columns` is how wide the row was given, not how many values it holds: four across at full width,
 * two across for a row inside half of a `SectionPair`. Four counts squeezed into half a row read as
 * a strip of digits, and the same four on two rows of two stay figures.
 */
function ValueCards({ values, columns = 4 }: { values: readonly LabelledValue[]; columns?: 2 | 4 }) {
  return (
    <div className={columns === 2 ? "grid grid-cols-1 sm:grid-cols-2 gap-4" : "grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4"}>
      {values.map((value) => (
        <MetricCard key={value.label} label={value.label} value={value.value} detail={value.detail} tone={value.tone} />
      ))}
    </div>
  );
}
