import { beforeEach, describe, expect, it, vi } from "vitest";
import { AvailabilityReason } from "../domain/availability.ts";
import { createGitHubClient } from "../github/client.ts";
import { personalAccessToken } from "../github/credentials.ts";
import { collectActionsPermissions } from "./repository-settings.ts";

/** A client whose one read answers with `status` and `body`, and the paths it was asked for. */
function answering(status: number, body: unknown): { client: ReturnType<typeof createGitHubClient>; paths: string[] } {
  const paths: string[] = [];
  const fetch = vi.fn((url: string | URL) => {
    paths.push(new URL(String(url)).pathname);
    return Promise.resolve(new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  }) as unknown as typeof globalThis.fetch;
  return {
    client: createGitHubClient({ credentials: personalAccessToken("ghp_test"), fetch, pause: () => Promise.resolve(), clock: () => 1000 }),
    paths
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, "debug").mockImplementation(() => undefined);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

describe("collectActionsPermissions", () => {
  it("should read the live answer GitHub gave for a repository allowing every action", async () => {
    // hmcts/cnp-flux-config's body, read with the App's installation token on 2026-11-13.
    const { client, paths } = answering(200, { enabled: true, allowed_actions: "all", sha_pinning_required: false });

    expect(await collectActionsPermissions(client, "hmcts", "cnp-flux-config")).toEqual({
      actions: { enabled: true, allowedActions: "all", shaPinningRequired: false }
    });
    expect(paths).toEqual(["/repos/hmcts/cnp-flux-config/actions/permissions"]);
  });

  it.each(["local_only", "selected"])("should read a policy of %s", async (allowed) => {
    const { client } = answering(200, { enabled: true, allowed_actions: allowed });

    expect(await collectActionsPermissions(client, "hmcts", "repo")).toEqual({ actions: { enabled: true, allowedActions: allowed } });
  });

  it("should read SHA pinning required", async () => {
    const { client } = answering(200, { enabled: true, allowed_actions: "selected", sha_pinning_required: true });

    expect(await collectActionsPermissions(client, "hmcts", "repo")).toEqual({
      actions: { enabled: true, allowedActions: "selected", shaPinningRequired: true }
    });
  });

  it("should leave SHA pinning unread when GitHub sends it as null", async () => {
    const { client } = answering(200, { enabled: true, allowed_actions: "all", sha_pinning_required: null });

    expect(await collectActionsPermissions(client, "hmcts", "repo")).toEqual({ actions: { enabled: true, allowedActions: "all" } });
  });

  it("should refuse a SHA pinning answer that is not a boolean", async () => {
    const { client } = answering(200, { enabled: true, allowed_actions: "all", sha_pinning_required: "yes" });

    const answer = await collectActionsPermissions(client, "hmcts", "repo");

    expect(answer.actions).toBeUndefined();
    expect(answer.failure).toContain("GitHub returned invalid Actions permissions");
  });

  it("should read Actions disabled, which carries no allowed_actions at all", async () => {
    const { client } = answering(200, { enabled: false });

    expect(await collectActionsPermissions(client, "hmcts", "repo")).toEqual({ actions: { enabled: false } });
  });

  it("should leave the setting unread, naming no failure, when GitHub answers 404", async () => {
    const { client } = answering(404, { message: "Not Found" });

    expect(await collectActionsPermissions(client, "hmcts", "repo")).toEqual({});
  });

  it("should leave the setting unread, naming no failure, when GitHub says the feature is off", async () => {
    const { client } = answering(403, { message: "Upgrade to GitHub Pro or make this repository public to enable this feature." });

    expect(await collectActionsPermissions(client, "hmcts", "repo")).toEqual({});
  });

  it("should rethrow an authentication failure, which is not about this repository", async () => {
    const { client } = answering(401, { message: "Bad credentials" });

    await expect(collectActionsPermissions(client, "hmcts", "repo")).rejects.toMatchObject({ reason: AvailabilityReason.AuthenticationFailed });
  });

  it("should leave the setting unread and name the failure when GitHub fails to answer", async () => {
    const { client } = answering(500, { message: "Server Error" });

    const answer = await collectActionsPermissions(client, "hmcts", "repo");

    expect(answer.actions).toBeUndefined();
    expect(answer.failure).toContain("Actions permissions could not be read");
  });

  it("should leave the setting unread and name the failure when GitHub refuses", async () => {
    const { client } = answering(403, { message: "Resource not accessible by integration" });

    const answer = await collectActionsPermissions(client, "hmcts", "repo");

    expect(answer.actions).toBeUndefined();
    expect(answer.failure).toContain("Actions permissions could not be read");
  });

  it("should leave the setting unread and name the failure when the body is malformed", async () => {
    const { client } = answering(200, { allowed_actions: "all" });

    const answer = await collectActionsPermissions(client, "hmcts", "repo");

    expect(answer.actions).toBeUndefined();
    expect(answer.failure).toContain("GitHub returned invalid Actions permissions");
  });
});
