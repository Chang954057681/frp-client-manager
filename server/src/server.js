'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, uid, nowISO, hashPassword, verifyPassword, seed, audit } = require('./db');
const { renderCommon, renderProxy, proxiesOf } = require('./config');
const frpc = require('./frpc');

seed();

const WEB = path.join(__dirname, '..', 'web');
const PORT = process.env.PORT || 8080;
const SESSION_TTL = 7 * 24 * 3600 * 1000;

/* ---------- 基础工具 ---------- */
function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', d => { b += d; if (b.length > 5e5) reject(new Error('body too large')); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function getCookies(req) {
  const c = req.headers.cookie || '';
  return Object.fromEntries(c.split(';').map(s => s.trim().split('=')).filter(x => x.length === 2).map(([k, v]) => [k, decodeURIComponent(v)]));
}
function setCookie(res, name, val, ttl) {
  res.setHeader('Set-Cookie', name + '=' + encodeURIComponent(val) + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + Math.floor(ttl / 1000));
}
function ipOf(req) { return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(); }

/* ---------- 会话 / 鉴权 ---------- */
function userBySession(req) {
  const sid = getCookies(req).sid;
  if (!sid) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE id=?').get(sid);
  if (!s) return null;
  if (new Date(s.expires_at).getTime() < Date.now()) { db.prepare('DELETE FROM sessions WHERE id=?').run(sid); return null; }
  return db.prepare('SELECT * FROM users WHERE id=?').get(s.user_id);
}
function requireAdmin(u, res) {
  if (u.role !== 'admin') { send(res, 403, { code: 40301, error: '需要管理员权限' }); return false; }
  return true;
}

function publicServer(s) {
  return { id: s.id, name: s.name, status: s.status, protocol: s.protocol, domain: s.domain,
    http_port: s.http_port, https_port: s.https_port, traffic_in: s.traffic_in || 0, traffic_out: s.traffic_out || 0 };
}
function fullServer(s) {
  const cnt = db.prepare('SELECT COUNT(*) AS c FROM proxies WHERE server_id=?').get(s.id).c;
  const run = db.prepare("SELECT COUNT(*) AS c FROM proxies WHERE server_id=? AND state='running'").get(s.id).c;
  return { ...s, proxyCount: cnt, proxyRunning: run };
}

/* ---------- 平台设置（品牌信息） ---------- */
const SETTINGS_DEFAULT = { site_name: 'FRP 客户端管理平台', site_short: 'FRP', site_logo: '', site_icon: '' };
function getSettings() {
  const out = { ...SETTINGS_DEFAULT };
  for (const r of db.prepare('SELECT key,value FROM settings').all()) {
    if (Object.prototype.hasOwnProperty.call(SETTINGS_DEFAULT, r.key) && r.value) out[r.key] = r.value;
  }
  return out;
}
function putSettings(obj) {
  const st = db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  for (const k of Object.keys(SETTINGS_DEFAULT)) if (obj[k] !== undefined) st.run(k, String(obj[k]));
}

/* ---------- 映射校验 ---------- */
function validateProxy(p) {
  const errs = [];
  if (!p.name) errs.push('映射名称不能为空');
  else if (!/^[A-Za-z0-9._-]+$/.test(p.name)) errs.push('名称只允许字母、数字、点、下划线、短横线');
  const dup = db.prepare('SELECT id FROM proxies WHERE server_id=? AND name=? AND id!=?').get(p.server_id, p.name, p.id || '');
  if (dup) errs.push('同一服务端下已存在同名映射');
  if (!p.local_ip) errs.push('本地 IP 不能为空');
  if (['tcp', 'udp', 'http', 'https', 'stcp', 'sudp', 'xtcp'].includes(p.type) && !p.local_port) errs.push('本地端口不能为空');
  if (['tcp', 'udp', 'tcpmux'].includes(p.type)) {
    if (!p.remote_port) errs.push('该类型必须填写远程端口');
    else {
      const c = db.prepare('SELECT id FROM proxies WHERE server_id=? AND remote_port=? AND id!=? AND enabled=1').get(p.server_id, p.remote_port, p.id || '');
      if (c) errs.push('远程端口已被占用（同一服务端内必须唯一）');
    }
  }
  if (['http', 'https'].includes(p.type) && !p.subdomain && !p.domains) errs.push('HTTP(S) 类型需至少填写子域名前缀或自定义域名之一');
  if (['stcp', 'sudp', 'xtcp'].includes(p.type) && (p.role || 'server') === 'server' && !p.secret_key) errs.push('安全隧道类型需填写 secretKey');
  if (p.remote_port && (p.remote_port < 1 || p.remote_port > 65535)) errs.push('远程端口超出合法范围');
  return errs;
}
function refreshProxyState(p) {
  const s = db.prepare('SELECT status FROM servers WHERE id=?').get(p.server_id);
  p.state = p.enabled && s && s.status === 'running' ? 'running' : 'stopped';
  db.prepare('UPDATE proxies SET state=? WHERE id=?').run(p.state, p.id);
}

/* ---------- 路由 ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  const method = req.method;

  /* 静态资源 */
  if (method === 'GET' && !pathname.startsWith('/api/')) {
    let f = pathname === '/' ? '/index.html' : pathname;
    const fp = path.join(WEB, path.normalize(f).replace(/^(\.\.[/\\])+/, ''));
    if (fp.startsWith(WEB) && fs.existsSync(fp) && fs.statSync(fp).isFile()) {
      const ext = path.extname(fp);
      const ct = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': ct });
      fs.createReadStream(fp).pipe(res);
    } else { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not Found'); }
    return;
  }

  try {
    const u = userBySession(req);
    const parts = pathname.split('/').filter(Boolean);

    if (pathname === '/api/login' && method === 'POST') {
      const b = await readBody(req);
      const row = db.prepare('SELECT * FROM users WHERE username=?').get(b.username);
      if (!row || !verifyPassword(b.password || '', row.password_hash) || row.status !== 'active')
        return send(res, 401, { code: 401, error: '账号或密码不正确' });
      const sid = uid('sess');
      db.prepare('INSERT INTO sessions(id,user_id,csrf,ip,ua,created_at,expires_at) VALUES(?,?,?,?,?,?,?)')
        .run(sid, row.id, crypto.randomBytes(8).toString('hex'), ipOf(req), req.headers['user-agent'] || '', nowISO(), new Date(Date.now() + SESSION_TTL).toISOString());
      db.prepare('UPDATE users SET last_login_at=?,last_login_ip=? WHERE id=?').run(nowISO(), ipOf(req), row.id);
      setCookie(res, 'sid', sid, SESSION_TTL);
      return send(res, 200, { ok: true, user: { username: row.username, role: row.role } });
    }
    if (pathname === '/api/logout' && method === 'POST') {
      const sid = getCookies(req).sid;
      if (sid) db.prepare('DELETE FROM sessions WHERE id=?').run(sid);
      res.setHeader('Set-Cookie', 'sid=; Path=/; Max-Age=0');
      return send(res, 200, { ok: true });
    }
    if (pathname === '/api/me' && method === 'GET') {
      if (!u) return send(res, 401, { code: 401, error: '未登录' });
      return send(res, 200, { user: { username: u.username, role: u.role } });
    }
    /* 平台设置：登录页也需读取品牌信息，故在鉴权之前 */
    if (pathname === '/api/settings' && method === 'GET') {
      return send(res, 200, { settings: getSettings() });
    }
    if (!u) return send(res, 401, { code: 401, error: '未登录' });

    /* 修改本人密码 */
    if (pathname === '/api/me/password' && method === 'POST') {
      const b = await readBody(req);
      const np = String(b.newPassword || '');
      if (np.length < 6) return send(res, 400, { code: 400, error: '新密码长度至少 6 位' });
      if (np === String(b.oldPassword || '')) return send(res, 400, { code: 400, error: '新密码不能与当前密码相同' });
      if (!verifyPassword(String(b.oldPassword || ''), u.password_hash)) return send(res, 400, { code: 400, error: '当前密码不正确' });
      db.prepare('UPDATE users SET password_hash=?,must_change_pwd=0,updated_at=? WHERE id=?').run(hashPassword(np), nowISO(), u.id);
      audit(u.username, '修改密码', u.username, '成功');
      return send(res, 200, { ok: true });
    }
    /* 平台设置：仅管理员可改 */
    if (pathname === '/api/settings' && method === 'PUT') {
      if (!requireAdmin(u, res)) return;
      putSettings(await readBody(req));
      audit(u.username, '修改平台设置', '品牌信息', '成功');
      return send(res, 200, { ok: true, settings: getSettings() });
    }

    /* 服务端 */
    if (parts[1] === 'servers') {
      if (parts.length === 2 && method === 'GET') {
        const rows = db.prepare('SELECT * FROM servers ORDER BY created_at').all();
        return send(res, 200, { servers: rows.map(r => u.role === 'admin' ? fullServer(r) : publicServer(r)) });
      }
      if (parts.length === 2 && method === 'POST') {
        if (!requireAdmin(u, res)) return;
        const b = await readBody(req);
        if (!b.name || !b.addr) return send(res, 400, { code: 400, error: '名称与服务端地址为必填项' });
        const id = uid('srv');
        db.prepare('INSERT INTO servers(id,name,addr,port,protocol,token,tls,mux,user,domain,http_port,https_port,admin_port,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(id, b.name, b.addr, b.port || 7000, b.protocol || 'tcp', b.token || '', b.tls !== false ? 1 : 0, b.mux !== false ? 1 : 0,
            b.user || '', b.domain || '', b.http_port || 80, b.https_port || 443, b.admin_port || 7401, 'stopped', nowISO(), nowISO());
        const r = await frpc.startServer(id);
        audit(u.username, '新增服务端', b.name, '成功');
        return send(res, 200, { ok: true, id, simulated: r.simulated });
      }
      const id = parts[2];
      if (parts.length === 3 && method === 'PUT') {
        if (!requireAdmin(u, res)) return;
        const b = await readBody(req);
        const s = db.prepare('SELECT * FROM servers WHERE id=?').get(id);
        if (!s) return send(res, 404, { error: '服务端不存在' });
        const commonChanged = s.addr !== b.addr || s.port != b.port || s.protocol !== b.protocol || s.token !== b.token ||
          s.tls != (b.tls !== false ? 1 : 0) || s.domain !== b.domain || s.http_port != b.http_port || s.https_port != b.https_port;
        db.prepare('UPDATE servers SET name=?,addr=?,port=?,protocol=?,token=?,tls=?,mux=?,user=?,domain=?,http_port=?,https_port=?,admin_port=?,updated_at=? WHERE id=?')
          .run(b.name, b.addr, b.port || 7000, b.protocol || 'tcp', b.token || '', b.tls !== false ? 1 : 0, b.mux !== false ? 1 : 0,
            b.user || '', b.domain || '', b.http_port || 80, b.https_port || 443, b.admin_port || 7401, nowISO(), id);
        let note = '未涉及 common 配置，无需重启';
        if (commonChanged) { await frpc.restartServer(id); note = 'common 变更，已重启实例（仅影响本服务端）'; }
        audit(u.username, '修改服务端', b.name, '成功');
        return send(res, 200, { ok: true, commonChanged, note });
      }
      if (parts.length === 3 && method === 'DELETE') {
        if (!requireAdmin(u, res)) return;
        const s = db.prepare('SELECT * FROM servers WHERE id=?').get(id);
        if (!s) return send(res, 404, { error: '服务端不存在' });
        frpc.stopServer(id);
        db.prepare('DELETE FROM proxies WHERE server_id=?').run(id);
        db.prepare('DELETE FROM servers WHERE id=?').run(id);
        audit(u.username, '删除服务端', s.name, '成功');
        return send(res, 200, { ok: true });
      }
      if (parts[3] === 'start' && method === 'POST') {
        if (!requireAdmin(u, res)) return;
        const r = await frpc.startServer(id);
        if (r.ok) db.prepare("UPDATE proxies SET state='running' WHERE server_id=? AND enabled=1").run(id);
        return send(res, 200, { ok: r.ok, simulated: r.simulated, error: r.error || null });
      }
      if (parts[3] === 'stop' && method === 'POST') {
        if (!requireAdmin(u, res)) return;
        const r = await frpc.stopServer(id);
        db.prepare("UPDATE proxies SET state='stopped' WHERE server_id=?").run(id);
        return send(res, 200, { ok: r.ok, error: r.error || null });
      }
      if (parts[3] === 'restart' && method === 'POST') {
        if (!requireAdmin(u, res)) return;
        const r = await frpc.restartServer(id);
        if (r.ok) db.prepare("UPDATE proxies SET state='running' WHERE server_id=? AND enabled=1").run(id);
        return send(res, 200, { ok: r.ok, simulated: r.simulated, error: r.error || null });
      }
      if (parts[3] === 'log' && method === 'GET') {
        if (!requireAdmin(u, res)) return;
        return send(res, 200, { log: frpc.getLog(id, 300) });
      }
      if (parts[3] === 'reload' && method === 'POST') {
        if (!requireAdmin(u, res)) return;
        const r = await frpc.reloadAdmin(db.prepare('SELECT * FROM servers WHERE id=?').get(id));
        return send(res, 200, { ok: r.ok, ms: r.ms, simulated: r.simulated, error: r.error });
      }
      if (parts[3] === 'config' && method === 'GET') {
        if (!requireAdmin(u, res)) return;
        const s = db.prepare('SELECT * FROM servers WHERE id=?').get(id);
        if (!s) return send(res, 404, { error: '服务端不存在' });
        return send(res, 200, { common: renderCommon(s), proxies: proxiesOf(id).map(renderProxy) });
      }
      if (parts[3] === 'preview' && method === 'GET') {
        const s = db.prepare('SELECT * FROM servers WHERE id=?').get(id);
        if (!s) return send(res, 404, { error: '服务端不存在' });
        return send(res, 200, { server: u.role === 'admin' ? fullServer(s) : publicServer(s), proxies: proxiesOf(id) });
      }
    }

    /* 映射 */
    if (parts[1] === 'proxies') {
      if (parts.length === 2 && method === 'GET') {
        const q = url.searchParams;
        let rows = db.prepare('SELECT * FROM proxies').all();
        if (q.get('serverId') && q.get('serverId') !== 'all') rows = rows.filter(p => p.server_id === q.get('serverId'));
        if (q.get('type') && q.get('type') !== 'all') rows = rows.filter(p => p.type === q.get('type'));
        if (q.get('state') && q.get('state') !== 'all') rows = rows.filter(p => p.state === q.get('state'));
        const kw = (q.get('q') || '').toLowerCase();
        if (kw) rows = rows.filter(p => (p.name + p.remark + p.local_ip).toLowerCase().includes(kw));
        return send(res, 200, { proxies: rows });
      }
      if (parts.length === 2 && method === 'POST') {
        const b = await readBody(req);
        const p = { id: uid('p'), server_id: b.server_id, name: b.name, type: b.type || 'tcp', local_ip: b.local_ip || '127.0.0.1',
          local_port: b.local_port != null ? Number(b.local_port) : null, remote_port: b.remote_port != null ? Number(b.remote_port) : null,
          subdomain: b.subdomain || null, domains: b.domains || null, role: b.role || 'server', secret_key: b.secret_key || null,
          bind_port: b.bind_port != null ? Number(b.bind_port) : null, enc: b.enc ? 1 : 0, comp: b.comp ? 1 : 0,
          bw: b.bw || null, enabled: b.enabled !== false ? 1 : 0, remark: b.remark || '', state: 'unknown', inb: 0, outb: 0, updated_at: nowISO() };
        const errs = validateProxy(p);
        if (errs.length) return send(res, 400, { code: 400, error: errs.join('；') });
        db.prepare('INSERT INTO proxies(id,server_id,name,type,local_ip,local_port,remote_port,subdomain,domains,role,secret_key,bind_port,enc,comp,bw,enabled,remark,state,inb,outb,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(p.id, p.server_id, p.name, p.type, p.local_ip, p.local_port, p.remote_port, p.subdomain, p.domains, p.role, p.secret_key, p.bind_port, p.enc, p.comp, p.bw, p.enabled, p.remark, p.state, p.inb, p.outb, p.updated_at);
        refreshProxyState(p);
        const r = await frpc.applyAndReload(p.server_id, u.username);
        audit(u.username, '新增映射', p.name, r.ok ? '成功' : '失败');
        return send(res, 200, { ok: r.ok, proxy: p, reload: r });
      }
      const id = parts[2];
      if (!id) return send(res, 400, { error: '缺少映射 id' });
      if (parts.length === 3 && method === 'PUT') {
        const b = await readBody(req);
        const old = db.prepare('SELECT * FROM proxies WHERE id=?').get(id);
        if (!old) return send(res, 404, { error: '映射不存在' });
        const p = { ...old, server_id: b.server_id || old.server_id, name: b.name, type: b.type || old.type, local_ip: b.local_ip || old.local_ip,
          local_port: b.local_port != null ? Number(b.local_port) : old.local_port, remote_port: b.remote_port != null ? Number(b.remote_port) : old.remote_port,
          subdomain: b.subdomain != null ? b.subdomain : old.subdomain, domains: b.domains != null ? b.domains : old.domains, role: b.role || old.role,
          secret_key: b.secret_key != null ? b.secret_key : old.secret_key, bind_port: b.bind_port != null ? Number(b.bind_port) : old.bind_port,
          enc: b.enc !== undefined ? (b.enc ? 1 : 0) : old.enc, comp: b.comp !== undefined ? (b.comp ? 1 : 0) : old.comp,
          bw: b.bw != null ? b.bw : old.bw, enabled: b.enabled !== undefined ? (b.enabled ? 1 : 0) : old.enabled, remark: b.remark != null ? b.remark : old.remark, updated_at: nowISO() };
        const errs = validateProxy(p);
        if (errs.length) return send(res, 400, { code: 400, error: errs.join('；') });
        db.prepare('UPDATE proxies SET server_id=?,name=?,type=?,local_ip=?,local_port=?,remote_port=?,subdomain=?,domains=?,role=?,secret_key=?,bind_port=?,enc=?,comp=?,bw=?,enabled=?,remark=?,updated_at=? WHERE id=?')
          .run(p.server_id, p.name, p.type, p.local_ip, p.local_port, p.remote_port, p.subdomain, p.domains, p.role, p.secret_key, p.bind_port, p.enc, p.comp, p.bw, p.enabled, p.remark, p.updated_at, id);
        refreshProxyState(p);
        const r = await frpc.applyAndReload(p.server_id, u.username);
        audit(u.username, '修改映射', p.name, r.ok ? '成功' : '失败');
        return send(res, 200, { ok: r.ok, proxy: p, reload: r });
      }
      if (parts.length === 3 && method === 'DELETE') {
        const old = db.prepare('SELECT * FROM proxies WHERE id=?').get(id);
        if (!old) return send(res, 404, { error: '映射不存在' });
        db.prepare('DELETE FROM proxies WHERE id=?').run(id);
        const r = await frpc.applyAndReload(old.server_id, u.username);
        audit(u.username, '删除映射', old.name, '成功');
        return send(res, 200, { ok: true, reload: r });
      }
      if (parts[3] === 'toggle' && method === 'POST') {
        const old = db.prepare('SELECT * FROM proxies WHERE id=?').get(id);
        if (!old) return send(res, 404, { error: '映射不存在' });
        const enabled = old.enabled ? 0 : 1;
        db.prepare('UPDATE proxies SET enabled=?,updated_at=? WHERE id=?').run(enabled, nowISO(), id);
        refreshProxyState({ ...old, enabled });
        const r = await frpc.applyAndReload(old.server_id, u.username);
        audit(u.username, enabled ? '启用映射' : '停用映射', old.name, '成功');
        return send(res, 200, { ok: true, reload: r });
      }
    }

    /* 导出 / 导入 */
    if (pathname === '/api/export' && method === 'GET') {
      const servers = db.prepare('SELECT id,name FROM servers').all();
      const proxies = db.prepare('SELECT id,server_id,name,type,local_ip,local_port,remote_port,subdomain,domains,role,secret_key,bind_port,enc,comp,bw,enabled,remark FROM proxies').all();
      return send(res, 200, { version: 1, kind: 'frpc-proxies', exportedAt: new Date().toISOString(), servers, proxies });
    }
    if (pathname === '/api/import' && method === 'POST') {
      const b = await readBody(req);
      let arr = Array.isArray(b) ? b : b.proxies;
      if (!Array.isArray(arr)) return send(res, 400, { code: 400, error: '顶层需为数组或含 proxies 数组' });
      let added = 0, skipped = 0; const affected = new Set();
      for (const raw of arr) {
        const s = db.prepare('SELECT * FROM servers WHERE id=? OR name=?').get(raw.server_id, raw.serverName);
        if (!s) { skipped++; continue; }
        let name = (raw.name || 'imported').trim();
        while (db.prepare('SELECT id FROM proxies WHERE server_id=? AND name=?').get(s.id, name)) name = name + '-' + crypto.randomBytes(2).toString('hex');
        const p = { id: uid('p'), server_id: s.id, name, type: raw.type || 'tcp', local_ip: raw.local_ip || '127.0.0.1',
          local_port: raw.local_port != null ? Number(raw.local_port) : null, remote_port: raw.remote_port != null ? Number(raw.remote_port) : null,
          subdomain: raw.subdomain || null, domains: raw.domains || null, role: raw.role || 'server', secret_key: raw.secret_key || null,
          bind_port: raw.bind_port != null ? Number(raw.bind_port) : null, enc: raw.enc ? 1 : 0, comp: raw.comp ? 1 : 0,
          bw: raw.bw || null, enabled: raw.enabled !== false ? 1 : 0, remark: raw.remark || '', state: 'unknown', inb: 0, outb: 0, updated_at: nowISO() };
        const errs = validateProxy(p);
        if (errs.length) { skipped++; continue; }
        db.prepare('INSERT INTO proxies(id,server_id,name,type,local_ip,local_port,remote_port,subdomain,domains,role,secret_key,bind_port,enc,comp,bw,enabled,remark,state,inb,outb,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(p.id, p.server_id, p.name, p.type, p.local_ip, p.local_port, p.remote_port, p.subdomain, p.domains, p.role, p.secret_key, p.bind_port, p.enc, p.comp, p.bw, p.enabled, p.remark, p.state, p.inb, p.outb, p.updated_at);
        refreshProxyState(p);
        affected.add(s.id); added++;
      }
      for (const sid of affected) await frpc.applyAndReload(sid, u.username);
      audit(u.username, '批量导入映射', added + ' 条', '成功');
      return send(res, 200, { ok: true, added, skipped });
    }

    /* 用户（仅 admin） */
    if (parts[1] === 'users') {
      if (!requireAdmin(u, res)) return;
      if (parts.length === 2 && method === 'GET')
        return send(res, 200, { users: db.prepare('SELECT id,username,role,status,last_login_at,remark FROM users').all() });
      if (parts.length === 2 && method === 'POST') {
        const b = await readBody(req);
        if (!b.username) return send(res, 400, { error: '账号必填' });
        if (db.prepare('SELECT id FROM users WHERE username=?').get(b.username)) return send(res, 400, { error: '账号已存在' });
        db.prepare('INSERT INTO users(id,username,password_hash,role,status,remark,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
          .run(uid('u'), b.username, hashPassword(b.password || 'user123'), b.role === 'admin' ? 'admin' : 'user', 'active', b.remark || '', nowISO(), nowISO());
        return send(res, 200, { ok: true });
      }
      const id = parts[2];
      if (parts[3] === 'password' && method === 'PUT') {
        const b = await readBody(req);
        const target = db.prepare('SELECT * FROM users WHERE id=?').get(id);
        if (!target) return send(res, 404, { error: '用户不存在' });
        const np = String(b.password || '');
        if (np.length < 6) return send(res, 400, { code: 400, error: '密码长度至少 6 位' });
        db.prepare('UPDATE users SET password_hash=?,must_change_pwd=0,updated_at=? WHERE id=?').run(hashPassword(np), nowISO(), id);
        audit(u.username, '修改用户密码', target.username, '成功');
        return send(res, 200, { ok: true });
      }
      if (parts.length === 3 && method === 'PUT') {
        const b = await readBody(req);
        db.prepare('UPDATE users SET role=?,status=?,remark=? WHERE id=?').run(b.role || 'user', b.status || 'active', b.remark || '', id);
        return send(res, 200, { ok: true });
      }
      if (parts.length === 3 && method === 'DELETE') {
        const me = db.prepare('SELECT username FROM users WHERE id=?').get(id);
        if (me && me.username === 'admin') return send(res, 400, { error: '不能删除初始管理员' });
        db.prepare('DELETE FROM users WHERE id=?').run(id);
        return send(res, 200, { ok: true });
      }
    }

    /* 审计 */
    if (pathname === '/api/audit' && method === 'GET') {
      if (!requireAdmin(u, res)) return;
      const rows = db.prepare('SELECT * FROM audit_logs ORDER BY ts DESC LIMIT 200').all();
      return send(res, 200, { audits: rows });
    }

    return send(res, 404, { code: 404, error: '接口不存在' });
  } catch (e) {
    return send(res, 500, { code: 500, error: String(e && e.message || e) });
  }
});

/* ---------- 指标轮询：逐代理状态 + frps 仪表盘流量 ---------- */
function getJsonSetting(key, def) {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  if (!r || !r.value) return def;
  try { return JSON.parse(r.value); } catch { return def; }
}
function httpJson(url, user, pass) {
  return new Promise((resolve, reject) => {
    const u = require('url').parse(url);
    const auth = (user && pass) ? { 'Authorization': 'Basic ' + Buffer.from(user + ':' + pass).toString('base64') } : {};
    const req = http.get({ host: u.hostname, port: u.port, path: u.path, headers: auth, timeout: 5000 }, res => {
      let b = ''; res.on('data', d => b += d); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('error', e => reject(e));
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}
async function pollMetrics() {
  try {
    const servers = db.prepare("SELECT * FROM servers WHERE status='running'").all();
    for (const s of servers) {
      /* 1) 逐代理真实状态（frpc Admin API，容器内存取） */
      const st = await frpc.fetchStatus(s);
      if (st) {
        const rows = db.prepare('SELECT id,name,enabled,state FROM proxies WHERE server_id=?').all(s.id);
        const upd = db.prepare('UPDATE proxies SET state=? WHERE id=?');
        db.prepare('BEGIN').run();
        for (const p of rows) {
          let state = p.state;
          if (!p.enabled) state = 'stopped';
          else if (st[p.name] === 'error') state = 'error';
          else if (st[p.name] === 'running') state = 'running';
          if (state !== p.state) upd.run(state, p.id);
        }
        db.prepare('COMMIT').run();
      }
      /* 2) frps 仪表盘流量（可达才取，逐代理接口不可用时仅取实例总量） */
      const dash = getJsonSetting('frps_dash', []).find(d => d.serverId === s.id);
      if (dash && dash.base) {
        try {
          const info = await httpJson(dash.base + '/api/serverinfo', dash.user, dash.pass);
          db.prepare('UPDATE servers SET traffic_in=?, traffic_out=? WHERE id=?').run(Number(info.totalTrafficIn) || 0, Number(info.totalTrafficOut) || 0, s.id);
          const tr = await httpJson(dash.base + '/api/proxy/traffic', dash.user, dash.pass);
          if (tr && Array.isArray(tr.proxies) && tr.proxies.length) {
            const upd2 = db.prepare('UPDATE proxies SET inb=?, outb=? WHERE server_id=? AND name=?');
            db.prepare('BEGIN').run();
            for (const x of tr.proxies) { const t = x.traffic || {}; upd2.run(Number(t.in) || 0, Number(t.out) || 0, s.id, x.name); }
            db.prepare('COMMIT').run();
          }
        } catch (e) { /* 仪表盘不可达则跳过，不影响状态同步 */ }
      }
    }
  } catch (e) { console.error('[metrics] poll failed:', e.message); }
}

server.listen(PORT, () => {
  frpc.reconcile();
  setInterval(pollMetrics, 20000);
  pollMetrics();
  console.log('[frp-manager] listening on http://localhost:' + PORT + (frpc.CONFIG_ONLY ? '  (config-only 模式：未找到 frpc 二进制，仅管理配置)' : ''));
});
