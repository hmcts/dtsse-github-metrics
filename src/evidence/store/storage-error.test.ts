import { describe, expect, it } from "vitest";
import { StorageError } from "./storage-error.ts";

describe("StorageError", () => {
  it("should name what failed and carry the driver's message after it", () => {
    const cause = new Error("connection refused");

    const error = new StorageError("could not read collection cache", cause);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("StorageError");
    expect(error.message).toBe("could not read collection cache: connection refused");
    expect(error.cause).toBe(cause);
  });

  it("should keep a cause that is not an Error without putting it in the message", () => {
    const error = new StorageError("could not read collection cache", "a bare string");

    expect(error.message).toBe("could not read collection cache");
    expect(error.cause).toBe("a bare string");
  });

  it("should carry no cause at all when none was given", () => {
    const error = new StorageError("could not read collection cache");

    expect(error.message).toBe("could not read collection cache");
    expect(error).not.toHaveProperty("cause");
  });
});
