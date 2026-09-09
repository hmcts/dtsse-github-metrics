import { createHash } from "node:crypto";
import { CodeownersPaths } from "./graph.ts";

/**
 * The GraphQL documents organisation-graph collection sends. Ported from `scripts/build_team_configuration.py`
 * in `hmcts/github-metrics`, which asked the same questions of the REST API one repository at a time.
 *
 * THESE DOCUMENTS WALK THE WHOLE ORGANISATION RATHER THAN ONE REPOSITORY, which is the difference that decides
 * every page size below. Behaviour collection pays per repository and is bounded by the report's window; this
 * pays once for 3,277 repositories, 336 teams and 1,100-odd members, so a document that is one round trip too
 * expensive is one round trip times the estate.
 *
 * Page sizes are DELIBERATELY BELOW GITHUB'S 100 MAXIMUM where a document nests connections, and they are
 * balanced rather than minimised, which is the same rule `behaviour/queries.ts` states: both nested
 * connections page on overflow, so a page too small is not WRONG, merely slow — every team exceeding it costs
 * an extra sequential round trip.
 *
 * Every document ends with `rateLimit { cost limit remaining resetAt }`. GraphQL charges POINTS rather than
 * calls, and a walk of this size is the one place in this build that can spend an hour's budget in a few
 * minutes, so the cost of each shape has to be visible in the response that paid it.
 */

/** The page-info selection every walk here terminates on. */
function pageInfoSelection(): string {
  return "pageInfo { hasNextPage endCursor }";
}

/** The member edge selection, shared so the bulk walk and its continuation cannot drift apart. */
function memberEdgeSelection(): string {
  return "edges { role node { login } }";
}

/** The repository edge selection, shared with the continuation for the same reason. */
function repositoryEdgeSelection(): string {
  return "edges { permission node { name isArchived } }";
}

/**
 * Every team of an organisation, with the people in it and the repositories it holds.
 *
 * `membership: IMMEDIATE` IS THE SINGLE MOST CONSEQUENTIAL PARAMETER IN THIS FILE AND IT IS NOT THE DEFAULT.
 * GitHub's default is `ALL`, which folds every descendant team's people into the parent: across the 336
 * nested teams of this organisation that makes a parent team look as though it employs its whole subtree, and
 * it makes "which teams is this person in" answer "the ancestry of the one team they actually joined". The
 * membership counts stay plausible while being wrong, which is why this is stated here rather than assumed.
 *
 * `rootTeamsOnly: false` is stated explicitly rather than relied on. It is GitHub's default today, but the
 * estate's teams NEST, and a default silently deciding otherwise would hide every child team — and with it
 * every repository a child team holds, which is where service-team ownership actually lives.
 *
 * `orderBy` on BOTH NESTED CONNECTIONS is not cosmetic. The digest comparison downstream is over a SET, but a
 * continuation cursor is over a SEQUENCE: an unordered connection may return the same member on two pages of
 * a paged walk and omit another, so a team would gain and lose people between runs and the graph would record
 * a supersession nothing in the organisation caused. Cheap insurance against a phantom change.
 *
 * The page sizes are 25 teams × (50 members + 50 repositories) = 2,500 nodes for one document, which GitHub
 * serves comfortably. Both nested connections page on overflow through the two focused queries below, so
 * these numbers trade round trips against a server-side timeout and nothing else.
 */
export function orgTeamsQuery(): string {
  return `
        query OrganizationTeams($organization: String!, $cursor: String) {
          organization(login: $organization) {
            teams(first: 25, after: $cursor, orderBy: { field: NAME, direction: ASC }, rootTeamsOnly: false) {
              totalCount
              ${pageInfoSelection()}
              nodes {
                slug name description privacy
                parentTeam { slug }
                members(first: 50, membership: IMMEDIATE, orderBy: { field: LOGIN, direction: ASC }) {
                  totalCount
                  ${pageInfoSelection()}
                  ${memberEdgeSelection()}
                }
                repositories(first: 50, orderBy: { field: NAME, direction: ASC }) {
                  totalCount
                  ${pageInfoSelection()}
                  ${repositoryEdgeSelection()}
                }
              }
            }
          }
          rateLimit { cost limit remaining resetAt }
        }
    `;
}

/**
 * The focused query used ONLY for a team whose member connection overflowed.
 *
 * `membership: IMMEDIATE` and the ordering are repeated verbatim from the bulk document, and both repetitions
 * are load-bearing: a continuation reading `ALL` would append a team's whole subtree to the 50 immediate
 * members already collected, and an unordered continuation would re-serve members the first page held.
 */
export function teamMembersQuery(): string {
  return `
        query TeamMembers($organization: String!, $slug: String!, $cursor: String) {
          organization(login: $organization) {
            team(slug: $slug) {
              members(first: 100, after: $cursor, membership: IMMEDIATE, orderBy: { field: LOGIN, direction: ASC }) {
                ${pageInfoSelection()}
                ${memberEdgeSelection()}
              }
            }
          }
          rateLimit { cost limit remaining resetAt }
        }
    `;
}

/**
 * The focused query used ONLY for a team whose repository connection overflowed.
 *
 * `first: 100` here against 50 in the bulk document, because this document nests nothing: one team, one
 * connection, one page of flat edges is what GitHub's maximum was set for.
 *
 * `@hmcts/platform-operations` OVERFLOWS THIS HEAVILY and that is the expected outcome, not a fault: a team
 * holding roughly 900 repositories costs nine sequential continuations. Nine round trips buys the access
 * evidence for a quarter of the estate, and no page size avoids them — GitHub's maximum is 100.
 */
export function teamRepositoriesQuery(): string {
  return `
        query TeamRepositories($organization: String!, $slug: String!, $cursor: String) {
          organization(login: $organization) {
            team(slug: $slug) {
              repositories(first: 100, after: $cursor, orderBy: { field: NAME, direction: ASC }) {
                ${pageInfoSelection()}
                ${repositoryEdgeSelection()}
              }
            }
          }
          rateLimit { cost limit remaining resetAt }
        }
    `;
}

/**
 * Every repository the organisation owns, whether a team holds it or not.
 *
 * 33 pages for 3,277 repositories, and `first: 100` is GitHub's maximum because ONE NODE PER REPOSITORY IS
 * WHAT MAKES THAT AFFORDABLE. There is deliberately no `repositoryTopics`, no `object(expression:)` and no
 * `collaborators` on this walk: each of the three is a CONNECTION, so adding one multiplies the node count of
 * every page by its own page size and drags the document back under the 100 ceiling the flat shape earns.
 * This is the same trade `commitHistoryQuery` documents when it takes `statusCheckRollup { state }` as a bare
 * scalar rather than paging `contexts` per commit — the topics and the blobs are fetched by whatever needs
 * them, for the repositories that need them, and not by the walk that must cover everything.
 *
 * `pushedAt` and `defaultBranchRef { name }` are scalars on the node and cost nothing extra; both are read
 * because the graph reports what a repository IS as well as who owns it, and "nobody has pushed to it since
 * 2019" is most of the answer to "does this ownership matter".
 */
export function orgRepositoriesQuery(): string {
  return `
        query OrganizationRepositories($organization: String!, $cursor: String) {
          organization(login: $organization) {
            repositories(first: 100, after: $cursor, orderBy: { field: NAME, direction: ASC }) {
              totalCount
              ${pageInfoSelection()}
              nodes { name isArchived isFork visibility pushedAt defaultBranchRef { name } }
            }
          }
          rateLimit { cost limit remaining resetAt }
        }
    `;
}

/**
 * Every member of the organisation and the role they hold in it.
 *
 * THERE ARE NO PER-USER `/users/{login}` CALLS ANYWHERE IN THIS COLLECTOR, and that is a decision rather than
 * an omission. The endpoint is perfectly readable and returns rather more than this does, which is exactly
 * why the absence needs stating: "it is readable" reads as "use it" unless a comment says otherwise. It is a
 * `core` call per member, and eleven hundred of them against a 5,000/hour budget is a fifth of the hour spent
 * on profile fields nothing decides anything with — the precise cost this bulk field exists to avoid.
 *
 * `name`, `email` and `company` come free on the edge's node. All three are SELF-REPORTED and frequently
 * blank, and `email` is the account's public address rather than a work one, so none of them is an identity;
 * see `PersonFact`.
 */
export function orgPeopleQuery(): string {
  return `
        query OrganizationPeople($organization: String!, $cursor: String) {
          organization(login: $organization) {
            membersWithRole(first: 100, after: $cursor) {
              totalCount
              ${pageInfoSelection()}
              edges { role node { login name email company } }
            }
          }
          rateLimit { cost limit remaining resetAt }
        }
    `;
}

/** How many repositories one ownership document reads. */
export const DefaultOwnershipBatchSize = 25;

/** Built documents by batch size, since the text is a function of the size and never of the data. */
const ownershipDocuments = new Map<number, string>();

/**
 * One document reading up to `batchSize` repositories' CODEOWNERS blobs, at every path GitHub resolves.
 *
 * REPOSITORY NAMES TRAVEL AS VARIABLES (`$r0`…`$rN`) AND THE ALIASES (`f0`…`fN`) CARRY ONLY POSITION. Two
 * reasons, and the first is the important one:
 *
 * A repository name reaching a GraphQL document as TEXT is an injection surface. The names come from
 * GitHub rather than from a user, which makes the risk small and not zero — a name containing a quote or a
 * brace would at best fail the whole batch of 25 and at worst change what the document asks for. As
 * variables they cannot be read as syntax at all, and the check is GitHub's rather than a quoting rule
 * somebody has to remember here.
 *
 * Second, a document whose text depends only on its batch SIZE is a small fixed set — one shape for the full
 * batch and one for the remainder — so it is built once and reused for all 131 batches, and it is the same
 * bytes in the log every time.
 *
 * The paths ARE interpolated, and that is not the same thing: `CodeownersPaths` is a constant in this
 * codebase, not a value fetched from anywhere.
 *
 * `isTruncated` is selected because the collector REFUSES a truncated blob rather than parsing half a file;
 * `byteSize` because "the file was too large to read" is worth reporting with its size.
 *
 * A batch of 25 repositories × 3 paths is 75 blob reads in one round trip: 131 documents for the estate,
 * against 9,831 REST calls for the same evidence.
 */
export function ownershipFilesQuery(batchSize: number = DefaultOwnershipBatchSize): string {
  const built = ownershipDocuments.get(batchSize);
  if (built !== undefined) {
    return built;
  }
  const positions = Array.from({ length: batchSize }, (_unused, index) => index);
  const declarations = positions.map((index) => `, $r${index}: String!`).join("");
  const files = CodeownersPaths.map((path, at) => `p${at}: object(expression: "HEAD:${path}") { ... on Blob { text byteSize isTruncated } }`).join(
    "\n            "
  );
  // `name` is echoed back so the collector can prove the alias it read belongs to the repository it asked
  // for: mismatched positions are the one way this scheme could quietly attribute one repository's owners
  // to another, and an assertion is cheaper than trusting the arithmetic.
  const repositories = positions
    .map(
      (index) => `
          f${index}: repository(owner: $organization, name: $r${index}) {
            name
            ${files}
          }`
    )
    .join("");
  const document = `
        query OwnershipFiles($organization: String!${declarations}) {${repositories}
          rateLimit { cost limit remaining resetAt }
        }
    `;
  ownershipDocuments.set(batchSize, document);
  return document;
}

/**
 * Identifies the shape of the organisation graph these documents collect.
 *
 * Its own signature rather than a share of `querySignature()`, for the reason that function gives: the graph
 * is collected and superseded independently of the behaviour windows, so widening one must not discard the
 * other's settled rows.
 *
 * The ownership document is hashed at its DEFAULT batch size only. The remainder batch's text differs by
 * repository count alone, which says nothing about the shape of what was read, and folding it in would change
 * the signature with the size of the estate.
 */
export function orgQuerySignature(): string {
  const documents = [
    orgTeamsQuery(),
    teamMembersQuery(),
    teamRepositoriesQuery(),
    orgRepositoriesQuery(),
    orgPeopleQuery(),
    ownershipFilesQuery(DefaultOwnershipBatchSize)
  ]
    .join("")
    .split(/\s+/)
    .join(" ");
  return createHash("sha256").update(documents).digest("hex").slice(0, 16);
}
