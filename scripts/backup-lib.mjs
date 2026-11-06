// Shared by the backup, restore and restore drill scripts.
//
// pg_dump and pg_restore must match the server's major version: a newer pg_dump writes
// settings an older server can't restore. They're used from PATH when that version is
// there; otherwise they run from Docker's official postgres image for the server's
// version, which needs nothing installed beyond Docker.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import pg from 'pg';

export const ROOT = path.resolve(import.meta.dirname, '..');
dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });

export const backupDir = () => path.resolve(ROOT, process.env.BACKUP_DIR || '.data/backups');
export const latestFile = () => path.join(backupDir(), 'latest.json');

/** The database URL without Prisma's ?schema=, which the Postgres tools don't accept. */
export const databaseUrl = (override) => {
  const raw = override || process.env.DATABASE_URL;
  if (!raw) throw new Error('DATABASE_URL is not set.');
  const url = new URL(raw);
  url.search = '';
  return url;
};

export const withDatabase = (url, name) => {
  const copy = new URL(url);
  copy.pathname = `/${name}`;
  return copy;
};

export const connect = async (url) => {
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  return client;
};

export const serverMajor = async (client) => {
  const { rows } = await client.query('SHOW server_version_num');
  return Math.floor(Number(rows[0].server_version_num) / 10000);
};

/** Exact row counts for every table in the public schema, in the client's transaction. */
export const tableCounts = async (client) => {
  const { rows } = await client.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );
  const counts = {};
  for (const { tablename } of rows) {
    const result = await client.query(`SELECT count(*)::bigint AS n FROM "${tablename}"`);
    counts[tablename] = Number(result.rows[0].n);
  }
  return counts;
};

const localMajor = (tool) => {
  const result = spawnSync(tool, ['--version'], { encoding: 'utf8' });
  if (result.status !== 0) return 0;
  return Number(/(\d+)(?:\.\d+)?/.exec(result.stdout)?.[1] ?? 0);
};

/**
 * Runs pg_dump or pg_restore. In args, {file} stands for the backup in backupDir() and
 * {url} for the database. Throws with the tool's output if it fails.
 */
export const runTool = (tool, args, { url, file, major }) => {
  let command;
  let finalArgs;
  if (localMajor(tool) === major) {
    command = tool;
    finalArgs = args.map((arg) =>
      arg.replace('{file}', path.join(backupDir(), file)).replace('{url}', url.toString()),
    );
  } else {
    // In Docker, the backup folder is mounted at /backups, and the host's database is
    // reached through the host network on Linux or host.docker.internal elsewhere.
    const inDocker = new URL(url);
    const local = ['localhost', '127.0.0.1'].includes(inDocker.hostname);
    if (local && process.platform !== 'linux') inDocker.hostname = 'host.docker.internal';
    command = 'docker';
    finalArgs = [
      'run',
      '--rm',
      ...(local && process.platform === 'linux' ? ['--network', 'host'] : []),
      '-v',
      `${backupDir().replace(/\\/g, '/')}:/backups`,
      `postgres:${major}-alpine`,
      tool,
      ...args.map((arg) => arg.replace('{file}', `/backups/${file}`).replace('{url}', inDocker.toString())),
    ];
  }
  const result = spawnSync(command, finalArgs, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`${tool} failed: ${(result.stderr || result.stdout || String(result.error)).trim()}`);
  }
};

export const readLatest = () => {
  try {
    return JSON.parse(fs.readFileSync(latestFile(), 'utf8'));
  } catch {
    return null;
  }
};

export const writeLatest = (data) => {
  fs.mkdirSync(backupDir(), { recursive: true });
  fs.writeFileSync(latestFile(), `${JSON.stringify(data, null, 2)}\n`);
};

/** Compares two sets of row counts. Returns the tables that differ. */
export const differences = (expected, actual) =>
  [...new Set([...Object.keys(expected), ...Object.keys(actual)])]
    .filter((table) => expected[table] !== actual[table])
    .map((table) => `${table}: expected ${expected[table] ?? 'missing'}, got ${actual[table] ?? 'missing'}`);
