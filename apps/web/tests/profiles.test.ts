/**
 * The profiles policy, run as two database roles.
 * A second hosted session could not be opened with the publishable key,
 * because a new email is not confirmed. This runs the migration SQL and
 * checks that the second role cannot read the first account's row.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "vitest";

const userA = "11111111-1111-4111-8111-111111111111";
const userB = "22222222-2222-4222-8222-222222222222";

const migration = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../supabase/migrations/20261112160000_profiles.sql",
  ),
  "utf8",
);

test("a second user cannot read the first user's profile", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create schema if not exists auth;
      create table auth.users (
        id uuid primary key,
        raw_user_meta_data jsonb not null default '{}'::jsonb
      );
      create or replace function auth.uid()
      returns uuid
      language sql
      stable
      as $$
        select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
      $$;
      create role anon nologin;
      create role authenticated nologin;
    `);
    await db.query(
      `insert into auth.users (id, raw_user_meta_data) values ($1, $2::jsonb)`,
      [userA, JSON.stringify({ full_name: "Ada" })],
    );
    await db.exec(migration);
    await db.query(
      `insert into auth.users (id, raw_user_meta_data) values ($1, $2::jsonb)`,
      [userB, JSON.stringify({ name: "Bea" })],
    );

    await become(db, userA);
    expect(await profileRows(db)).toEqual([{ id: userA, display_name: "Ada" }]);

    await become(db, userB);
    const other = await profileRows(db);
    expect(other).toEqual([{ id: userB, display_name: "Bea" }]);
    const pointed = await db.query<{ id: string }>(
      `select id from public.profiles where id = $1`,
      [userA],
    );
    expect(pointed.rows).toEqual([]);

    await db.exec(`reset role`);
    await db.exec(`set role anon`);
    await expect(db.query(`select id from public.profiles`)).rejects.toThrow(
      /permission denied/i,
    );
  } finally {
    await db.close();
  }
});

async function become(db: PGlite, userId: string): Promise<void> {
  await db.exec(`reset role`);
  await db.exec(`set role authenticated`);
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [
    userId,
  ]);
}

async function profileRows(
  db: PGlite,
): Promise<{ id: string; display_name: string | null }[]> {
  const result = await db.query<{ id: string; display_name: string | null }>(
    `select id, display_name from public.profiles order by id`,
  );
  return result.rows;
}
