import { describe, expect, it } from "vitest";
import {
  assertPreviewTarget,
  changeNumber,
  type DumpSource,
  dumpSource,
  GuardError,
  libpqConninfo,
  PREVIEW_SERVER_HOST,
  previewDatabaseName,
  previewTarget,
  previewUrl
} from "./target.ts";

const AAT = {
  AAT_POSTGRES_HOST: "dts-github-metrics-aat.postgres.database.azure.com",
  AAT_POSTGRES_PORT: "5432",
  AAT_POSTGRES_USER: "pgadmin",
  AAT_POSTGRES_PASSWORD: "aat-password",
  AAT_POSTGRES_DATABASE: "github_metrics"
};

const SECRET = { HOST: PREVIEW_SERVER_HOST, PORT: "5432", USER: "hmcts", PASSWORD: "preview-password" };

describe("changeNumber", () => {
  it("should accept a pull-request number", () => {
    expect(changeNumber("75")).toBe("75");
  });

  it.each([undefined, "", "  ", "0", "075", "75a", "-1", "7 5", "../postgres", "1; DROP"])("should refuse %j when it is not a pull-request number", (value) => {
    expect(() => changeNumber(value)).toThrow(GuardError);
  });
});

describe("previewDatabaseName", () => {
  it("should name the release's own database when given the pull-request number", () => {
    expect(previewDatabaseName("75")).toBe("dtsse-github-metrics-pr-75");
  });
});

describe("dumpSource", () => {
  it("should read the five AAT variables when all are set", () => {
    expect(dumpSource(AAT)).toMatchObject({ host: AAT.AAT_POSTGRES_HOST, database: "github_metrics", user: "pgadmin" });
  });

  it.each(Object.keys(AAT))("should refuse when %s is missing", (missing) => {
    expect(() => dumpSource({ ...AAT, [missing]: undefined })).toThrow(`${missing} is not set`);
  });

  it.each([
    PREVIEW_SERVER_HOST,
    PREVIEW_SERVER_HOST.toUpperCase(),
    `${PREVIEW_SERVER_HOST}.`,
    ` ${PREVIEW_SERVER_HOST}`
  ])("should refuse a source of %j when it is the preview server", (host) => {
    expect(() => dumpSource({ ...AAT, AAT_POSTGRES_HOST: host })).toThrow(/names the preview server/);
  });
});

describe("previewTarget", () => {
  const source = dumpSource(AAT);

  it("should target the PR's database on the preview server when the secret names it", () => {
    expect(previewTarget(SECRET, "75", source)).toEqual({
      host: PREVIEW_SERVER_HOST,
      port: "5432",
      user: "hmcts",
      password: "preview-password",
      database: "dtsse-github-metrics-pr-75"
    });
  });

  it("should refuse when the secret names any server but the preview one", () => {
    expect(() => previewTarget({ ...SECRET, HOST: AAT.AAT_POSTGRES_HOST }, "75", source)).toThrow(/not the preview server/);
  });

  it("should refuse when the source and the target are the same server, however the check upstream was bypassed", () => {
    const bypassed = { ...source, host: PREVIEW_SERVER_HOST.toUpperCase() } as DumpSource;

    expect(() => previewTarget(SECRET, "75", bypassed)).toThrow(/both/);
  });

  it.each(["HOST", "PORT", "USER", "PASSWORD"])("should refuse when the secret has no %s", (missing) => {
    expect(() => previewTarget({ ...SECRET, [missing]: undefined }, "75", source)).toThrow(GuardError);
  });

  it("should refuse when there is no pull-request number, so master can never reach a destructive statement", () => {
    expect(() => previewTarget(SECRET, undefined, source)).toThrow("CHANGE_ID is not set");
  });

  it("should never carry the source's credentials into the target", () => {
    const target = previewTarget(SECRET, "75", source);

    expect(Object.values(target)).not.toContain(AAT.AAT_POSTGRES_PASSWORD);
    expect(Object.values(target)).not.toContain(AAT.AAT_POSTGRES_HOST);
  });
});

describe("assertPreviewTarget", () => {
  const target = previewTarget(SECRET, "75", dumpSource(AAT));

  it("should pass the PR's database on the preview server", () => {
    expect(() => assertPreviewTarget(target)).not.toThrow();
  });

  it("should refuse AAT when a source is handed over in a target's place", () => {
    expect(() => assertPreviewTarget(dumpSource(AAT))).toThrow(/only dtsse-preview/);
  });

  it.each([
    "github_metrics",
    "postgres",
    "expressjs-monorepo-template-pr-780",
    "dtsse-github-metrics",
    "dtsse-github-metrics-pr-75x",
    "dtsse-github-metrics-pr-0"
  ])("should refuse database %j when it is not a pull request's own", (database) => {
    expect(() => assertPreviewTarget({ ...target, database })).toThrow(/only a pull request's own database/);
  });
});

describe("libpqConninfo", () => {
  it("should require TLS and leave the password out", () => {
    const conninfo = libpqConninfo(dumpSource(AAT));

    expect(conninfo).toContain("sslmode=require");
    expect(conninfo).toContain("host='dts-github-metrics-aat.postgres.database.azure.com'");
    expect(conninfo).not.toContain(AAT.AAT_POSTGRES_PASSWORD);
  });

  it("should quote a value holding a quote or a backslash so it cannot add a keyword", () => {
    expect(libpqConninfo({ ...dumpSource(AAT), user: "a' dbname='postgres\\" })).toContain("user='a\\' dbname=\\'postgres\\\\'");
  });
});

describe("previewUrl", () => {
  it("should encode a password holding URL delimiters", () => {
    const target = previewTarget({ ...SECRET, PASSWORD: "p@ss/w:rd" }, "75", dumpSource(AAT));

    expect(previewUrl(target)).toBe(`postgresql://hmcts:p%40ss%2Fw%3Ard@${PREVIEW_SERVER_HOST}:5432/dtsse-github-metrics-pr-75?sslmode=require`);
  });
});
