// Backs up the database to BACKUP_DIR (default .data/backups) as a pg_dump custom-format
// file, and records it in latest.json with every table's row count. The counts come from
// the same snapshot the dump is taken from, so a restore can be checked against them
// exactly, even while traffic keeps writing. Keeps the newest BACKUP_KEEP backups (14).
//
// Usage: npm run db:backup
import fs from 'node:fs';
import path from 'node:path';
import { backupDir, connect, databaseUrl, runTool, serverMajor, tableCounts, writeLatest, readLatest } from './backup-lib.mjs';

export const backup = async () => {
  const url = databaseUrl();
  const database = url.pathname.slice(1);
  const startedAt = new Date();
  const stamp = startedAt.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  const file = `${database}-${stamp}.dump`;
  fs.mkdirSync(backupDir(), { recursive: true });

  const client = await connect(url);
  try {
    const major = await serverMajor(client);
    // One snapshot for the counts and the dump.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const { rows } = await client.query('SELECT pg_export_snapshot() AS snapshot');
    const tables = await tableCounts(client);
    runTool('pg_dump', ['--format=custom', '--no-owner', `--snapshot=${rows[0].snapshot}`, '--file={file}', '--dbname={url}'], {
      url,
      file,
      major,
    });
    await client.query('COMMIT');

    const bytes = fs.statSync(path.join(backupDir(), file)).size;
    const previous = readLatest();
    const latest = {
      file,
      database,
      serverMajor: major,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      bytes,
      tables,
      ...(previous?.lastDrill ? { lastDrill: previous.lastDrill } : {}),
    };
    writeLatest(latest);

    // Keep the newest few.
    const keep = Number(process.env.BACKUP_KEEP || 14);
    const old = fs
      .readdirSync(backupDir())
      .filter((name) => name.startsWith(`${database}-`) && name.endsWith('.dump'))
      .sort()
      .reverse()
      .slice(keep);
    for (const name of old) fs.rmSync(path.join(backupDir(), name));

    return latest;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
};

// Run directly, not imported by the restore drill.
if (process.argv[1]?.endsWith('backup.mjs')) {
  backup()
    .then((latest) => {
      const rows = Object.values(latest.tables).reduce((sum, n) => sum + n, 0);
      console.log(
        `Backed up ${latest.database} to ${latest.file}: ${(latest.bytes / 1e6).toFixed(1)} MB, ` +
          `${Object.keys(latest.tables).length} tables, ${rows.toLocaleString('en-GB')} rows.`,
      );
    })
    .catch((error) => {
      console.error(`Backup failed: ${error.message}`);
      process.exit(1);
    });
}
