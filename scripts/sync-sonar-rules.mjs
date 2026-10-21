// Snapshots the Sonar rules this project is scanned with into `sonar-rules.json`, which `eslint.config.mjs` reads.
//
//   yarn lint:sonar:sync
//
// COMMITTED RATHER THAN FETCHED ON EVERY LINT, so `yarn lint` needs no network and gives the same answer in CI as on
// a laptop. Re-run it when the quality profile changes in SonarCloud, and commit the result.
//
// Two public endpoints, no token. The quality profile's active rules, each with the scope Sonar applies it to (MAIN
// code, TEST code, or ALL), and any rule an open issue was raised under that the profile does not list: SonarCloud
// has reported S8786 against this project although its profile does not include it.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const properties = readFileSync(path.join(root, "sonar-project.properties"), "utf8");
const project = properties.match(/^sonar\.projectKey=(.+)$/m)?.[1]?.trim();
const organization = "hmcts";
if (project === undefined) {
  throw new Error("sonar-project.properties names no sonar.projectKey");
}

async function json(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} answered ${response.status}`);
  }
  return await response.json();
}

const api = "https://sonarcloud.io/api";
const profiles = await json(`${api}/qualityprofiles/search?organization=${organization}&project=${project}&language=ts`);
const profile = profiles.profiles[0]?.key;
if (profile === undefined) {
  throw new Error(`SonarCloud lists no TypeScript quality profile for ${project}`);
}
const active = await json(`${api}/rules/search?organization=${organization}&qprofile=${profile}&activation=true&ps=500&f=scope`);
const raised = await json(`${api}/issues/search?componentKeys=${project}&resolved=false&ps=1&facets=rules`);

const bare = (key) => key.replace(/^typescript:/, "");
const rules = new Map(active.rules.map((rule) => [bare(rule.key), rule.scope]));
for (const { val } of raised.facets[0]?.values ?? []) {
  // A rule with open issues but no entry in the profile is taken to be MAIN, as nine in ten of the profile's are.
  if (!rules.has(bare(val))) {
    rules.set(bare(val), "MAIN");
  }
}

const byCodePoint = ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0);
const snapshot = { project, profile: profiles.profiles[0].name, rules: Object.fromEntries([...rules].sort(byCodePoint)) };
writeFileSync(path.join(root, "sonar-rules.json"), `${JSON.stringify(snapshot, null, 2)}\n`);
console.info(`sonar-rules.json: ${rules.size} rules from the "${snapshot.profile}" profile of ${project}`);
