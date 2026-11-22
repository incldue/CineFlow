'use strict';

const fs = require('node:fs');
const path = require('node:path');

const STATE_FILE = 'cineflow-gpu.json';

function readState(userDataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(userDataDir || '', STATE_FILE), 'utf8'));
    const mode = String(parsed && parsed.mode || '');
    if (mode === 'on' || mode === 'off' || mode === 'auto') return { mode };
  } catch {  }
  return { mode: 'auto' };
}

function writeState(userDataDir, state) {
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(path.join(userDataDir, STATE_FILE), JSON.stringify({ mode: state.mode, updatedAt: Date.now() }, null, 2), 'utf8');
    return true;
  } catch { return false; }
}

function hasNvidiaDriver(fsRef = fs) {
  try {
    if (fsRef.existsSync('/proc/driver/nvidia/version')) return true;
  } catch {  }
  try {
    if (fsRef.existsSync('/sys/module/nvidia')) return true;
  } catch {  }
  try {
    const modules = fsRef.readFileSync('/proc/modules', 'utf8');
    if (/^nvidia(_drm|_modeset)?\s/m.test(modules)) return true;
  } catch {  }
  return false;
}

function isWayland(env = process.env) {
  const session = String(env.XDG_SESSION_TYPE || '').toLowerCase();
  if (session === 'wayland') return true;
  return Boolean(env.WAYLAND_DISPLAY);
}

function decide({ platform, env = {}, wayland = false, nvidia = false, mode = 'auto' }) {
  if (platform !== 'linux') return { disable: false, reason: '非 Linux，不干预' };
  if (String(env.CINEFLOW_KEEP_GPU || '') === '1') return { disable: false, reason: 'CINEFLOW_KEEP_GPU=1 强制保留' };
  if (String(env.CINEFLOW_DISABLE_GPU || '') === '1') return { disable: true, reason: 'CINEFLOW_DISABLE_GPU=1 强制关闭' };
  if (mode === 'off') return { disable: true, reason: '设置里已选择关闭' };
  if (mode === 'on') return { disable: false, reason: '设置里已选择开启' };
  if (wayland && nvidia) return { disable: true, reason: 'Wayland + NVIDIA 自动关闭' };
  if (wayland) return { disable: false, reason: 'Wayland 非 NVIDIA，保持硬件加速' };
  return { disable: false, reason: 'X11 会话，保持硬件加速' };
}

let lastState = { supported: false, disabled: false, mode: 'auto', reason: '', wayland: false, nvidia: false };

function install({ app, userDataDir, log = () => {} } = {}) {
  const platform = process.platform;
  if (platform !== 'linux') return { applied: false, ...lastState };
  const env = process.env;
  const state = readState(userDataDir);
  const wayland = isWayland(env);
  const nvidia = hasNvidiaDriver();
  const verdict = decide({ platform, env, wayland, nvidia, mode: state.mode });
  lastState = { supported: true, disabled: verdict.disable, mode: state.mode, reason: verdict.reason, wayland, nvidia };
  if (!verdict.disable) {
    log('图形加速保持开启 · ' + verdict.reason);
    return { applied: false, ...lastState };
  }
  try {
    if (typeof app.disableHardwareAcceleration === 'function') app.disableHardwareAcceleration();
    const cl = app.commandLine;
    if (cl && typeof cl.appendSwitch === 'function') {
      cl.appendSwitch('disable-gpu');
      cl.appendSwitch('disable-gpu-compositing');
      cl.appendSwitch('disable-gpu-rasterization');
    }
    log('已关闭硬件加速 · ' + verdict.reason);
    return { applied: true, ...lastState };
  } catch (error) {
    log('关闭硬件加速失败 · ' + String((error && error.message) || error));
    return { applied: false, ...lastState };
  }
}

function registerIpc({ ipcMain, userDataDir, app, log = () => {} }) {
  if (!ipcMain || typeof ipcMain.handle !== 'function' || typeof ipcMain.removeHandler !== 'function') return false;
  const state = () => {
    const stored = readState(userDataDir);
    const wayland = process.platform === 'linux' ? isWayland(process.env) : false;
    const nvidia = process.platform === 'linux' ? hasNvidiaDriver() : false;
    return {
      supported: process.platform === 'linux',
      mode: stored.mode,
      wayland,
      nvidia,
      disabled: process.platform === 'linux' ? decide({ platform: process.platform, env: process.env, wayland, nvidia, mode: stored.mode }).disable : false,
      applied: lastState.disabled,
      reason: process.platform === 'linux' ? decide({ platform: process.platform, env: process.env, wayland, nvidia, mode: stored.mode }).reason : '仅 Linux 生效',
      restartRequired: true
    };
  };
  try { ipcMain.removeHandler('cf:m2:gpu-get'); } catch {  }
  try { ipcMain.removeHandler('cf:m2:gpu-set'); } catch {  }
  try {
    ipcMain.handle('cf:m2:gpu-get', async () => state());
    ipcMain.handle('cf:m2:gpu-set', async (_event, payload) => {
      const mode = String((payload && payload.mode) || '');
      if (!['auto', 'on', 'off'].includes(mode)) return { ok: false, error: '无效选项' };
      if (process.platform !== 'linux') return { ok: false, error: '仅 Linux 生效' };
      const saved = writeState(userDataDir, { mode });
      log('图形加速设置改为 ' + mode + (saved ? '' : '（写入失败，仅本次内存生效）'));
      return { ok: true, ...state() };
    });
  } catch (error) {
    log('图形加速 IPC 注册失败 · ' + String((error && error.message) || error));
    return false;
  }
  return true;
}

module.exports = { install, registerIpc, decide, isWayland, hasNvidiaDriver, readState, writeState, _state: () => lastState };
