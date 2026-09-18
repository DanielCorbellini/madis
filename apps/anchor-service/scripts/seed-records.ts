import { canonicalize } from "crypto-utils";
import { type HDNodeWallet, Wallet } from "ethers";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Pool } from "pg";
import { from as copyFrom } from "pg-copy-streams";
import { createDbPool } from "service-runtime";

// The standard, publicly-known Hardhat/Anvil test mnemonic — never used for
// real funds, deterministic so re-running this script always signs as the
// same address (0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266).
export const TEST_MNEMONIC =
  "test test test test test test test test test test test junk";

export type RecordType = "prescription" | "emr_encounter";

const DRUGS = [
  "Amoxicillin",
  "Metformin",
  "Lisinopril",
  "Atorvastatin",
  "Omeprazole",
];
const FREQUENCIES = ["once daily", "twice daily", "every 8 hours", "as needed"];
const DIAGNOSIS_CODES = ["J06.9", "I10", "E11.9", "M54.5", "R51"];
const PROVIDERS = ["Silva", "Souza", "Oliveira", "Costa", "Pereira"];

/**
 * Deterministic, cycling fixture data — no randomness, so a given `--count`
 * always produces the same payloads. Kept free of quotes/backslashes/tabs/
 * newlines: COPY's text format backslash-escapes those, which plain
 * JSON.stringify output does not do.
 */
function buildPayload(
  type: RecordType,
  index: number,
): Record<string, unknown> {
  if (type === "prescription") {
    return {
      patientId: index,
      drug: DRUGS[index % DRUGS.length],
      dosageMg: 100 + (index % 5) * 100,
      frequency: FREQUENCIES[index % FREQUENCIES.length],
      prescribedBy: `Dr. ${PROVIDERS[index % PROVIDERS.length]}`,
    };
  }

  return {
    patientId: index,
    diagnosisCode: DIAGNOSIS_CODES[index % DIAGNOSIS_CODES.length],
    provider: `Dr. ${PROVIDERS[index % PROVIDERS.length]}`,
    notes: `Routine visit number ${index}`,
  };
}

function parseCliArgs(argv: string[]): {
  count: number;
  type: RecordType;
  truncate: boolean;
} {
  const { values } = parseArgs({
    args: argv,
    options: {
      count: { type: "string" },
      type: { type: "string" },
      truncate: { type: "boolean", default: false },
    },
  });

  const count = Number(values.count);
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error("--count must be a positive integer");
  }

  if (values.type !== "prescription" && values.type !== "emr_encounter") {
    throw new Error('--type must be "prescription" or "emr_encounter"');
  }

  return { count, type: values.type, truncate: values.truncate === true };
}

/** The only `admin_user` use in this service — explicitly test/fixture-only (§14). */
export async function truncateAll(adminDatabaseUrl: string): Promise<void> {
  const admin = new Pool({ connectionString: adminDatabaseUrl });
  try {
    await admin.query(
      "TRUNCATE records, batches, anchor_records, integrity_alerts RESTART IDENTITY CASCADE",
    );
  } finally {
    await admin.end();
  }
}

/**
 * Inserts `count` signed, valid `records` rows of `type` via the same COPY
 * path `batch-repository.ts` uses, as `app_user`. IDs are reserved upfront
 * from `records_id_seq` (one round trip) so entity_id = id can be embedded
 * directly in the streamed COPY lines, mirroring `record-repository.ts`'s
 * `createEntity` convention for a brand-new entity.
 */
export async function seedRecords(
  pool: Pool,
  wallet: HDNodeWallet,
  type: RecordType,
  count: number,
): Promise<void> {
  const { rows } = await pool.query<{ id: string }>(
    "SELECT nextval('records_id_seq') AS id FROM generate_series(1, $1)",
    [count],
  );

  const client = await pool.connect();
  try {
    const copyStream = client.query(
      copyFrom(
        "COPY records (id, entity_id, record_type, payload, version, client_address, signature) FROM STDIN",
      ),
    );

    async function* lines(): AsyncGenerator<string> {
      for (let i = 0; i < count; i++) {
        const id = rows[i].id;
        const payload = buildPayload(type, i);

        // console.log(payload);
        // console.log(canonicalize(payload));

        const signature = wallet.signMessageSync(canonicalize(payload));

        yield `${id}\t${id}\t${type}\t${JSON.stringify(payload)}\t1\t${wallet.address}\t${signature}\n`;
      }
    }

    await pipeline(Readable.from(lines()), copyStream);
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const { count, type, truncate } = parseCliArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL environment variable is required");
  }

  const wallet = Wallet.fromPhrase(TEST_MNEMONIC);
  console.log(
    `Seeding as ${wallet.address} — this address must be in WHITELIST_ADDRESSES for anchor-service to accept these records.`,
  );

  if (truncate) {
    const adminDatabaseUrl = process.env.ADMIN_DATABASE_URL;

    if (!adminDatabaseUrl) {
      throw new Error(
        "--truncate requires ADMIN_DATABASE_URL (the admin_user DSN — see db/setup-users.sql)",
      );
    }

    await truncateAll(adminDatabaseUrl);
    console.log(
      "Truncated records, batches, anchor_records, integrity_alerts.",
    );
  }

  const pool = createDbPool(databaseUrl);
  try {
    await seedRecords(pool, wallet, type, count);
  } finally {
    await pool.end();
  }

  console.log(`Inserted ${count} ${type} record(s).`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
