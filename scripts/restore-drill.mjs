// Proves a backup can be restored: takes a fresh backup, restores it into a scratch
// database on the same server, and checks every table has exactly the rows the backup
// recorded. Drops the scratch database afterwards and records the result in latest.json.
// Exits with 1 if anything differs.
//
// Usage: npm run db:restore-drill
import { backup } from './backup.mjs';
import { connect, databaseUrl, differences, readLatest, tableCounts, withDatabase, writeLatest } from './backup-lib.mjs';
import { restore } from './restore.mjs';

const drill = async () => {
  const latest = await backup();
  const scratch = `${latest.database}_restore_drill`;
  const admin = await connect(withDatabase(databaseUrl(), 'postgres'));
  const started = Date.now();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${scratch}"`);
    let counts;
    try {
      const target = await restore(latest.file, scratch);
      const restored = await connect(target);
      try {
        counts = await tableCounts(restored);
      } finally {
        await restored.end();
      }
    } catch (error) {
      // A backup that won't restore is a failed drill, recorded so the alert sees it.
      const result = {
        at: new Date().toISOString(),
        file: latest.file,
        ok: false,
        seconds: Math.round((Date.now() - started) / 100) / 10,
        problems: [error.message],
      };
      writeLatest({ ...readLatest(), lastDrill: result });
      return result;
    }
    const problems = differences(latest.tables, counts);
    const result = {
      at: new Date().toISOString(),
      file: latest.file,
      ok: problems.length === 0,
      seconds: Math.round((Date.now() - started) / 100) / 10,
      tables: Object.keys(counts).length,
      rows: Object.values(counts).reduce((sum, n) => sum + n, 0),
      problems,
    };
    writeLatest({ ...readLatest(), lastDrill: result });
    return result;
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS "${scratch}"`).catch(() => undefined);
    await admin.end();
  }
};

drill()
  .then((result) => {
    if (result.ok) {
      console.log(
        `Restore drill passed: ${result.file} restored in ${result.seconds} s, ` +
          `${result.tables} tables and ${result.rows.toLocaleString('en-GB')} rows, all matching.`,
      );
    } else {
      console.error(`Restore drill FAILED for ${result.file}:\n  ${result.problems.join('\n  ')}`);
      process.exit(1);
    }
  })
  .catch((error) => {
    console.error(`Restore drill failed: ${error.message}`);
    process.exit(1);
  });
