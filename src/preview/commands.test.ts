import { describe, expect, it } from "vitest";
import {
  deploymentName,
  dumpCommand,
  listPodsCommand,
  readReplicasCommand,
  readSecretCommand,
  restoreCommand,
  rolloutStatusCommand,
  scaleCommand
} from "./commands.ts";
import { dumpSource, PREVIEW_SERVER_HOST, type PreviewTarget, previewTarget } from "./target.ts";

const IMAGE = "hmctsprod.azurecr.io/imported/postgres:16-alpine";
const source = dumpSource({
  AAT_POSTGRES_HOST: "dts-github-metrics-aat.postgres.database.azure.com",
  AAT_POSTGRES_PORT: "5432",
  AAT_POSTGRES_USER: "pgadmin",
  AAT_POSTGRES_PASSWORD: "aat-password",
  AAT_POSTGRES_DATABASE: "github_metrics"
});
const target = previewTarget({ HOST: PREVIEW_SERVER_HOST, PORT: "5432", USER: "hmcts", PASSWORD: "preview-password" }, "75", source);

describe("dumpCommand", () => {
  it("should dump in custom format without owners or grants, from the source", () => {
    const command = dumpCommand(IMAGE, source);

    expect(command.args).toEqual(expect.arrayContaining(["pg_dump", "--format=custom", "--no-owner", "--no-privileges"]));
    expect(command.args.join(" ")).toContain("dts-github-metrics-aat");
    expect(command.password).toBe("aat-password");
  });

  it("should pass the password by name only, so it is never an argument", () => {
    const command = dumpCommand(IMAGE, source);

    expect(command.args).toContain("PGPASSWORD");
    expect(command.args.join(" ")).not.toContain("aat-password");
  });

  it("should use the host network, so the private DNS zones resolve", () => {
    expect(dumpCommand(IMAGE, source).args.slice(0, 5)).toEqual(["run", "--rm", "--interactive", "--network", "host"]);
  });
});

describe("restoreCommand", () => {
  it("should restore in one transaction that stops at the first error, into the target", () => {
    const command = restoreCommand(IMAGE, target);

    expect(command.args).toEqual(expect.arrayContaining(["pg_restore", "--exit-on-error", "--single-transaction", "--no-owner", "--no-privileges"]));
    expect(command.args.join(" ")).toContain("dbname='dtsse-github-metrics-pr-75'");
    expect(command.args.join(" ")).not.toContain("preview-password");
    expect(command.password).toBe("preview-password");
  });

  it("should refuse a source handed over in a target's place", () => {
    expect(() => restoreCommand(IMAGE, source as unknown as PreviewTarget)).toThrow(/only dtsse-preview/);
  });
});

describe("kubectl commands", () => {
  it("should name the release's nodejs deployment", () => {
    expect(deploymentName(target)).toBe("dtsse-github-metrics-pr-75-nodejs");
  });

  it("should pin every call to the namespace, and to the context when one is given", () => {
    expect(scaleCommand("cft-preview-00-aks", target, 0)).toEqual({
      program: "kubectl",
      args: ["--context", "cft-preview-00-aks", "--namespace", "dtsse", "scale", "deployment/dtsse-github-metrics-pr-75-nodejs", "--replicas=0"]
    });
    expect(readSecretCommand(undefined).args).toEqual(["--namespace", "dtsse", "get", "secret", "postgres", "--output", "json"]);
  });

  it("should select the deployment's pods, read its replicas and wait on its rollout", () => {
    expect(listPodsCommand(undefined, target).args).toContain("app.kubernetes.io/name=dtsse-github-metrics-pr-75-nodejs");
    expect(readReplicasCommand(undefined, target).args).toContain("jsonpath={.spec.replicas}");
    expect(rolloutStatusCommand(undefined, target, 600).args).toEqual(
      expect.arrayContaining(["rollout", "status", "deployment/dtsse-github-metrics-pr-75-nodejs", "--timeout=600s"])
    );
  });
});
