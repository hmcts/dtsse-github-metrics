import { afterEach, describe, expect, it, vi } from "vitest";
import { CVE_CONTAINER } from "./collect.ts";
import { readCveDocuments } from "./cosmos.ts";
import { CVE_PAGE_SIZE, cveDocumentQuery } from "./documents.ts";

const cosmos = vi.hoisted(() => ({
  clients: [] as unknown[],
  databases: [] as string[],
  containers: [] as string[],
  queries: [] as unknown[][],
  pages: [] as unknown[][]
}));
const cveDocumentsFrom = vi.hoisted(() =>
  vi.fn(async function* (pages: AsyncIterable<unknown[]>, database: string) {
    for await (const page of pages) {
      for (const document of page) {
        yield { database, document };
      }
    }
  })
);

vi.mock("@azure/cosmos", () => ({
  CosmosClient: class {
    constructor(options: unknown) {
      cosmos.clients.push(options);
    }
    database(id: string) {
      cosmos.databases.push(id);
      return {
        container(container: string) {
          cosmos.containers.push(container);
          return {
            items: {
              query(...args: unknown[]) {
                cosmos.queries.push(args);
                const remaining = [...cosmos.pages];
                return {
                  hasMoreResults: () => remaining.length > 0,
                  fetchNext: async () => ({ resources: remaining.shift() })
                };
              }
            }
          };
        }
      };
    }
  }
}));
vi.mock("./documents.ts", async (original) => ({ ...(await original<typeof import("./documents.ts")>()), cveDocumentsFrom }));

afterEach(() => {
  cosmos.clients = [];
  cosmos.databases = [];
  cosmos.containers = [];
  cosmos.queries = [];
  cosmos.pages = [];
});

describe("readCveDocuments", () => {
  it("should query the container of the named database and pump every page through the guard", async () => {
    cosmos.pages = [["a", "b"], ["c"]];

    const read = [];
    for await (const document of readCveDocuments({ endpoint: "https://cosmos.example", key: "read-only" }, "sds-jenkins", 1700000000)) {
      read.push(document);
    }

    expect(cosmos.clients).toEqual([{ endpoint: "https://cosmos.example", key: "read-only" }]);
    expect(cosmos.databases).toEqual(["sds-jenkins"]);
    expect(cosmos.containers).toEqual([CVE_CONTAINER]);
    expect(cosmos.queries).toEqual([[cveDocumentQuery(1700000000), { maxItemCount: CVE_PAGE_SIZE }]]);
    expect(read).toEqual([
      { database: "sds-jenkins", document: "a" },
      { database: "sds-jenkins", document: "b" },
      { database: "sds-jenkins", document: "c" }
    ]);
  });

  it("should yield nothing when the query returns no pages", async () => {
    const read = [];
    for await (const document of readCveDocuments({ endpoint: "https://cosmos.example", key: "read-only" }, "jenkins", undefined)) {
      read.push(document);
    }

    expect(read).toEqual([]);
  });
});
