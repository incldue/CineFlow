'use strict';

const fs = require('node:fs');
const path = require('node:path');
const telemetry = require('./telemetry.cjs');

const BACKUP_KEEP = 5;

function listBackups(backupDir) {
  try {
    return fs.readdirSync(backupDir)
      .filter((name) => /^settings-.*\.json$/.test(name))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

function backupSettings({ app, log = () => {} } = {}) {
  const result = { backedUp: false, backups: 0 };
  try {
    if (!app) return result;
    const dir = app.getPath('userData');
    const file = path.join(dir, 'settings.json');
    const backupDir = path.join(dir, 'settings-backups');
    if (!fs.existsSync(file)) return result;
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(file, path.join(backupDir, `settings-${stamp}.json`));
    result.backedUp = true;
    const files = listBackups(backupDir);
    result.backups = files.length;
    for (const stale of files.slice(BACKUP_KEEP)) {
      try { fs.unlinkSync(path.join(backupDir, stale)); } catch {  }
    }
    telemetry.record('settings.backup', { backups: result.backups });
    log(`settings.json 已备份（共 ${result.backups} 份滚动备份）`);
  } catch (error) {
    telemetry.record('settings.backup.error', { error: String(error?.message || error).slice(0, 80) });
  }
  return result;
}

module.exports = { backupSettings, BACKUP_KEEP, _internals: { listBackups } };
