import pg from "pg";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { asSoleCollector, takeCollectorLock } from "../../src/evidence/store/collector-lock.ts";
import { prisma } from "../../src/evidence/store/prisma.ts";

// Postgres advisory locks are a database behaviour, so these cases need a real database — a stub would only
// prove that a fake returned what it was told to. AAT runs this application on two clusters against ONE
// database and one GitHub App installation, so "two collectors at once" is the normal case rather than an
// exotic one, and it used to be prevented by suspending a CronJob by hand where nothing recorded why.

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * Makes the next `end()` close the connection and then report a failure, as a socket that dropped mid-close does.
 *
 * The connection really is closed first, so a case exercising the failure leaves no session holding the lock.
 */
function failNextEnd(): void {
  const end = pg.Client.prototype.end as (this: pg.Client) => Promise<void>;
  vi.spyOn(pg.Client.prototype, "end").mockImplementationOnce(async function (this: pg.Client) {
    await end.call(this);
    throw new Error("the connection was already gone");
  });
}

describe("takeCollectorLock", () => {
  it("should grant the lock when nobody holds it", async () => {
    const lock = await takeCollectorLock();

    try {
      expect(lock.held).toBe(true);
    } finally {
      await lock.release();
    }
  });

  it("should refuse a second holder while the first has it", async () => {
    // THE CASE THAT MATTERS: this is one process standing in for the second cluster. Without it, both runs
    // proceed, spend one rate-limit budget twice, and collide on the live-row unique indexes — which rolls back
    // a whole graph write rather than merely duplicating work.
    const first = await takeCollectorLock();

    try {
      const second = await takeCollectorLock();
      try {
        expect(first.held).toBe(true);
        expect(second.held).toBe(false);
      } finally {
        await second.release();
      }
    } finally {
      await first.release();
    }
  });

  it("should grant the lock again once the holder releases it", async () => {
    const first = await takeCollectorLock();
    await first.release();

    const second = await takeCollectorLock();

    try {
      expect(second.held).toBe(true);
    } finally {
      await second.release();
    }
  });

  it("should release the lock even when the holder threw", async () => {
    // A collector that dies mid-walk must not lock the estate out until somebody notices. The dedicated
    // connection is closed in a `finally`, and ending the session drops the lock even if the unlock never ran.
    await expect(
      asSoleCollector(() => {
        throw new Error("the walk failed");
      })
    ).rejects.toThrow("the walk failed");

    const after = await takeCollectorLock();
    try {
      expect(after.held).toBe(true);
    } finally {
      await after.release();
    }
  });
});

describe("a connection that fails part-way", () => {
  it("should close the connection and report the failure when the lock cannot be asked for", async () => {
    vi.spyOn(pg.Client.prototype, "query").mockRejectedValueOnce(new Error("the server went away"));
    failNextEnd();

    await expect(takeCollectorLock()).rejects.toThrow("the server went away");

    expect(pg.Client.prototype.end).toHaveBeenCalledTimes(1);
  });

  it("should release without throwing when the unlock and the close both fail, since ending the session frees the lock", async () => {
    const lock = await takeCollectorLock();
    vi.spyOn(pg.Client.prototype, "query").mockRejectedValueOnce(new Error("the server went away"));
    failNextEnd();

    await expect(lock.release()).resolves.toBeUndefined();

    vi.restoreAllMocks();
    const after = await takeCollectorLock();
    try {
      expect(after.held).toBe(true);
    } finally {
      await after.release();
    }
  });
});

describe("asSoleCollector", () => {
  it("should run the collection and return its result when it holds the lock", async () => {
    await expect(asSoleCollector(async () => "collected")).resolves.toBe("collected");
  });

  it("should not run the collection at all when another holds the lock", async () => {
    const held = await takeCollectorLock();
    let ran = false;

    try {
      const result = await asSoleCollector(async () => {
        ran = true;
        return "collected";
      });

      // `undefined` rather than a thrown error, because the caller reports a stand-down as SUCCESS: on an estate
      // where both clusters share a schedule, one loses every day, and a daily alert for correct behaviour is one
      // nobody reads.
      expect(result).toBeUndefined();
      expect(ran).toBe(false);
    } finally {
      await held.release();
    }
  });

  it("should release the lock after a successful run, so the next run can take it", async () => {
    await asSoleCollector(async () => "first");

    await expect(asSoleCollector(async () => "second")).resolves.toBe("second");
  });
});
