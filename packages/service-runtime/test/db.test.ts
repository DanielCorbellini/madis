import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkDatabaseConnection } from "../src/db.ts";

describe("checkDatabaseConnection", () => {
  it("issues a SELECT 1 against the pool", async () => {
    const queries: string[] = [];
    await checkDatabaseConnection({
      async query(text: string) {
        queries.push(text);
        return { rows: [] };
      },
    });

    assert.deepEqual(queries, ["SELECT 1"]);
  });

  it("rejects when the pool query fails", async () => {
    await assert.rejects(
      checkDatabaseConnection({
        async query() {
          throw new Error("connection refused");
        },
      }),
      { message: "connection refused" },
    );
  });
});
