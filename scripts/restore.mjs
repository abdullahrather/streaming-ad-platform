// Restores a backup made by db:backup.
//
// Usage: npm run db:restore -- [file|latest] [--into <database>] [--yes]
//
//   file       A .dump in BACKUP_DIR. Defaults to the newest one (latest.json).
//   --into     Restore into another database on the same server, created if needed.
//              Without it, the backup replaces the database in DATABASE_URL, which
//              needs --yes, since everything written since the backup is lost.
import { backupDir, connect, databaseUrl, readLatest, runTool, serverMajor, withDatabase } from './backup-lib.mjs';
import fs from 'node:fs';
import path from 'node:path';

/** Restores `file` into `database`, replacing what's there. Returns the database's URL. */
export const restore = async (file, database) => {
  const source = databaseUrl();
  const target = withDatabase(source, database);
  if (!fs.existsSync(path.join(backupDir(), file))) throw new Error(`No backup named ${file} in ${backupDir()}.`);

  const admin = await connect(withDatabase(source, 'postgres'));
  try {
    const major = await serverMajor(admin);
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
    if (exists.rowCount === 0) await admin.query(`CREATE DATABASE "${database}"`);
    runTool('pg_restore', ['--clean', '--if-exists', '--no-owner', '--exit-on-error', '--dbname={url}', '{file}'], {
      url: target,
      file,
      major,
    });
    return target;
  } finally {
    await admin.end();
  }
};

// Run directly, not imported by the restore drill.
if (process.argv[1]?.endsWith('restore.mjs')) {
  const args = process.argv.slice(2);
  const intoAt = args.indexOf('--into');
  const into = intoAt >= 0 ? args[intoAt + 1] : null;
  // The file is the first argument that isn't a flag or the name after --into.
  const named = args.find(
    (arg, index) => !arg.startsWith('--') && (intoAt < 0 || index !== intoAt + 1),
  );
  const file = !named || named === 'latest' ? readLatest()?.file : named;
  const live = databaseUrl().pathname.slice(1);

  if (!file) {
    console.error('No backup found. Run npm run db:backup first.');
    process.exit(1);
  }
  if (!into && !args.includes('--yes')) {
    console.error(
      `This replaces the ${live} database with ${file}, losing everything since. ` +
        'Add --yes to go ahead, or --into <name> to restore into another database.',
    );
    process.exit(1);
  }
  restore(file, into ?? live)
    .then(() => console.log(`Restored ${file} into ${into ?? live}.`))
    .catch((error) => {
      console.error(`Restore failed: ${error.message}`);
      process.exit(1);
    });
}
