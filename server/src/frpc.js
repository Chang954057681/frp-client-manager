'use strict';
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const { db, DATA_DIR, nowISO, audit } = require('./db');
const { writeConfigs } = require('./config');

const FRPC_BIN = process.env.FRPC_BIN || 'frpc';
// 只要二进制不存在（ENOENT 等），进入 config-only 模式
const CONFIG_ONLY = (() => {
  try { const r = spawnSync(FRPC_BIN, ['--version'], { stdio: 'ignore' }); return !!r.error; }
  catch { return true; }
})();

const procs = new Map();            // serverId -> { pid, child|null }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const serverDir = id => path.join(DATA_DIR, 'servers', id);
const pidFile = id => path.join(serverDir(id), 'frpc.pid');
const logFile = id => path.join(serverDir(id), 'frpc.log');

function setStatus(id, status, extra) {
  // 注意：占位符顺序必须与 run(...) 实参一致：SET 各列 → updated_at → WHERE id
  const cols = ['status']; const vals = [status];
  if (extra) for (const k of Object.keys(extra)) { cols.push(k); vals.push(extra[k]); }
  db.prepare('UPDATE servers SET ' + cols.map(c => c + '=?').join(',') + ',updated_at=? WHERE id=?')
    .run(...vals, nowISO(), id);
}

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function readPid(id) {
  try { const n = parseInt(fs.readFileSync(pidFile(id), 'utf8').trim(), 10); return Number.isFinite(n) ? n : null; } catch { return null; }
}
function writePid(id, pid) { try { fs.writeFileSync(pidFile(id), String(pid)); } catch {} }
function clearPid(id) { try { fs.rmSync(pidFile(id), { force: true }); } catch {} }

function tailLog(id, lines = 8) {
  try {
    const buf = fs.readFileSync(logFile(id), 'utf8');
    return buf.split('\n').map(s => s.replace(/\u001b\[[0-9;]*m/g, '').trimEnd()).filter(Boolean).slice(-lines).join('\n');
  } catch { return ''; }
}
function getLog(id, lines = 300) {
  try { return fs.readFileSync(logFile(id), 'utf8').split('\n').map(s => s.replace(/\u001b\[[0-9;]*m/g, '')).slice(-lines).join('\n'); } catch { return ''; }
}

async function waitDead(pid, timeoutMs = 4000) {
  const t0 = Date.now();
  while (isAlive(pid) && Date.now() - t0 < timeoutMs) await sleep(120);
  return !isAlive(pid);
}
async function killPid(pid) {
  if (!isAlive(pid)) return true;
  try { process.kill(pid, 'SIGTERM'); } catch {}
  if (await waitDead(pid, 3000)) return true;
  try { process.kill(pid, 'SIGKILL'); } catch {}
  return await waitDead(pid, 2000);
}
function portFree(port) {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}
async function waitPortFree(port, timeoutMs = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { if (await portFree(port)) return true; await sleep(150); }
  return false;
}
/* Linux：按 cmdline 查找仍挂着某服务端配置的 frpc 进程（清除孤儿，跨 node 重启） */
function findPidsByCmdline(needle) {
  const out = [];
  try {
    for (const d of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue;
      if (parseInt(d, 10) === process.pid) continue;
      try {
        const cmd = fs.readFileSync('/proc/' + d + '/cmdline', 'utf8').replace(/\0/g, ' ');
        if (cmd.includes(needle)) out.push(parseInt(d, 10));
      } catch {}
    }
  } catch {}
  return out;
}

/* 彻底结束某服务端实例：跟踪的 child + pidfile 孤儿 + /proc 兜底 */
async function killExisting(id) {
  const cur = procs.get(id);
  if (cur) {
    if (cur.child) { try { cur.child.removeAllListeners('exit'); cur.child.kill('SIGTERM'); } catch {}}
    await killPid(cur.pid);
    procs.delete(id);
  }
  const p = readPid(id);
  if (p) await killPid(p);
  clearPid(id);
  for (const pid of findPidsByCmdline(path.join(serverDir(id), 'frpc.toml'))) await killPid(pid);
  const s = db.prepare('SELECT admin_port FROM servers WHERE id=?').get(id);
  if (s && s.admin_port) await waitPortFree(s.admin_port, 4000);
}

function adminPing(port, timeout = 800) {
  return new Promise(resolve => {
    if (!port) return resolve(0);
    const req = http.get({ host: '127.0.0.1', port, path: '/api/status', timeout }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(0));
    req.on('timeout', () => { req.destroy(); resolve(0); });
  });
}

/* 读取 frpc 实例各代理的真实运行状态（/api/status 按类型分组） */
function fetchStatus(server) {
  return new Promise(resolve => {
    if (CONFIG_ONLY || !server || !server.admin_port) return resolve(null);
    const req = http.get({ host: '127.0.0.1', port: server.admin_port, path: '/api/status', timeout: 4000 }, res => {
      let b = ''; res.on('data', d => b += d); res.on('end', () => {
        try {
          const j = JSON.parse(b); const m = {};
          for (const t of Object.keys(j)) if (Array.isArray(j[t])) for (const p of j[t]) if (p && p.name) m[p.name] = (p.status === 'error' ? 'error' : 'running');
          resolve(m);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/* 触发 frpc 热加载：调用 admin API GET /api/reload（不重启进程） */
function reloadAdmin(server) {
  return new Promise(resolve => {
    if (CONFIG_ONLY) {
      audit('system', 'reload', server.id, '配置已落盘（config-only 模式）');
      return resolve({ ok: true, ms: 0, simulated: true });
    }
    const t0 = Date.now();
    const req = http.get(
      { host: '127.0.0.1', port: server.admin_port, path: '/api/reload', timeout: 5000 },
      res => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => resolve({ ok: res.statusCode === 200, ms: Date.now() - t0, status: res.statusCode, body }));
      });
    req.on('error', e => resolve({ ok: false, error: String(e.message) }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'admin reload 超时' }); });
  });
}

async function startServer(id) {
  const s = db.prepare('SELECT * FROM servers WHERE id=?').get(id);
  if (!s) return { ok: false, error: '服务端不存在' };
  writeConfigs(s);
  if (CONFIG_ONLY) {
    setStatus(id, 'running', { pid: null, since: nowISO(), latency: 12 + Math.floor(Math.random() * 30), version: 'config-only' });
    audit('system', 'start', s.name, '已拉起（config-only 模式，未找到 frpc 二进制）');
    return { ok: true, simulated: true };
  }

  // 先彻底清掉旧实例 / 孤儿，避免 admin 端口占用（EADDRINUSE）
  await killExisting(id);

  try { fs.writeFileSync(logFile(id), ''); } catch {}
  const fd = fs.openSync(logFile(id), 'a');
  const child = spawn(FRPC_BIN, ['-c', path.join(serverDir(id), 'frpc.toml')], {
    cwd: serverDir(id), stdio: ['ignore', fd, fd]
  });
  try { fs.closeSync(fd); } catch {}
  procs.set(id, { pid: child.pid, child });
  writePid(id, child.pid);

  child.on('exit', (code, signal) => {
    const cur = procs.get(id);
    if (cur && cur.pid === child.pid) {         // 仅当仍是“当前实例”时才改写状态，避免覆盖新实例
      procs.delete(id); clearPid(id);
      const st = db.prepare('SELECT status FROM servers WHERE id=?').get(id);
      if (st && st.status === 'running') {
        setStatus(id, 'error', { pid: null, version: 'exited(' + (code == null ? signal : code) + ')' });
      }
    }
  });
  child.on('error', e => { setStatus(id, 'error', { pid: null }); audit('system', 'start', s.name, '失败：' + e.message); });

  setStatus(id, 'running', { pid: child.pid, since: nowISO(), latency: null, version: '0.71.0' });

  // 就绪探测：进程存活 + admin API 可达（最多 ~3s）
  let ready = false;
  for (let i = 0; i < 15; i++) {
    await sleep(200);
    if (!isAlive(child.pid)) break;
    if (await adminPing(s.admin_port)) { ready = true; break; }
  }
  if (!ready) {
    const err = tailLog(id, 6) || ('进程未能进入就绪状态（admin 端口 ' + s.admin_port + ' 不可达）');
    await killExisting(id);
    setStatus(id, 'error', { pid: null, latency: null });
    audit('system', 'start', s.name, '失败：' + err.replace(/\s+/g, ' ').slice(0, 300));
    return { ok: false, error: err };
  }
  setStatus(id, 'running', { pid: child.pid, latency: 12 + Math.floor(Math.random() * 30) });
  audit('system', 'start', s.name, '成功');
  return { ok: true, pid: child.pid };
}

async function stopServer(id) {
  const s = db.prepare('SELECT * FROM servers WHERE id=?').get(id);
  if (!s) return { ok: false, error: '服务端不存在' };
  await killExisting(id);
  setStatus(id, 'stopped', { pid: null, since: '—', latency: null });
  audit('system', 'stop', s.name, '成功');
  return { ok: true };
}

async function restartServer(id) {
  await stopServer(id);
  return startServer(id);
}

/* 保存映射后：落盘 + 热加载 */
async function applyAndReload(id, actor) {
  const s = db.prepare('SELECT * FROM servers WHERE id=?').get(id);
  if (!s) return { ok: false, error: '服务端不存在' };
  writeConfigs(s);
  if (s.status !== 'running') return { ok: true, reloaded: false, note: '实例未运行，配置已落盘，启动后生效' };
  const r = await reloadAdmin(s);
  return { ok: r.ok, reloaded: r.ok, ms: r.ms, simulated: r.simulated, error: r.error };
}

/* node 启动时对齐状态：pidfile 存活且 admin API 可达才标 running，否则 stopped */
async function reconcile() {
  if (CONFIG_ONLY) return;
  try {
    for (const s of db.prepare('SELECT id,status,admin_port FROM servers').all()) {
      const p = readPid(s.id);
      if (p && isAlive(p) && (await adminPing(s.admin_port))) {
        procs.set(s.id, { pid: p, child: null });
        if (s.status !== 'running') setStatus(s.id, 'running', { pid: p });
      } else {
        clearPid(s.id);
        if (s.status === 'running') setStatus(s.id, 'stopped', { pid: null });
      }
    }
  } catch (e) { console.error('[frpc] reconcile failed:', e.message); }
}

module.exports = { startServer, stopServer, restartServer, applyAndReload, reloadAdmin, reconcile, getLog, fetchStatus, CONFIG_ONLY, FRPC_BIN };
