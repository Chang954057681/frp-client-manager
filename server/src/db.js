'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'servers'), { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'manager.db'));
db.exec('PRAGMA journal_mode=WAL;');
db.exec('PRAGMA foreign_keys=ON;');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS servers(
  id TEXT PRIMARY KEY, name TEXT, addr TEXT, port INTEGER, protocol TEXT,
  token TEXT, tls INTEGER DEFAULT 1, mux INTEGER DEFAULT 1, user TEXT,
  domain TEXT, http_port INTEGER DEFAULT 80, https_port INTEGER DEFAULT 443,
  admin_port INTEGER, status TEXT DEFAULT 'stopped', pid INTEGER, latency INTEGER,
  version TEXT, since TEXT, created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS proxies(
  id TEXT PRIMARY KEY, server_id TEXT, name TEXT, type TEXT, local_ip TEXT, local_port INTEGER,
  remote_port INTEGER, subdomain TEXT, domains TEXT, role TEXT DEFAULT 'server', secret_key TEXT,
  bind_port INTEGER, enc INTEGER DEFAULT 1, comp INTEGER DEFAULT 1, bw TEXT, enabled INTEGER DEFAULT 1,
  remark TEXT, state TEXT DEFAULT 'unknown', inb INTEGER DEFAULT 0, outb INTEGER DEFAULT 0, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS users(
  id TEXT PRIMARY KEY, username TEXT UNIQUE, password_hash TEXT, role TEXT, status TEXT DEFAULT 'active',
  last_login_at TEXT, last_login_ip TEXT, must_change_pwd INTEGER DEFAULT 0, remark TEXT, created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions(
  id TEXT PRIMARY KEY, user_id TEXT, csrf TEXT, ip TEXT, ua TEXT, created_at TEXT, expires_at TEXT
);
CREATE TABLE IF NOT EXISTS audit_logs(
  id TEXT PRIMARY KEY, ts TEXT, actor TEXT, action TEXT, target TEXT, result TEXT
);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
`;
db.exec(SCHEMA);
/* 增量迁移：服务端实例累计流量 */
for (const col of ['traffic_in', 'traffic_out']) {
  try { db.exec(`ALTER TABLE servers ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`); } catch (e) {}
}

/* ---------- 工具 ---------- */
const uid = (p = 'id') => p + '_' + crypto.randomBytes(6).toString('hex');
const nowISO = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64);
  return 'scrypt$' + salt.toString('hex') + '$' + h.toString('hex');
}
function verifyPassword(pw, stored) {
  try {
    const parts = String(stored).split('$');
    if (parts.length !== 3) return false;
    const h = crypto.scryptSync(pw, Buffer.from(parts[1], 'hex'), 64);
    return crypto.timingSafeEqual(h, Buffer.from(parts[2], 'hex'));
  } catch { return false; }
}

/* ---------- 种子数据 ---------- */
function seed() {
  const u = db.prepare('SELECT COUNT(*) AS c FROM users').get();
  if (u.c === 0) {
    const mk = (username, pw, role, remark) => db.prepare(
      'INSERT INTO users(id,username,password_hash,role,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)'
    ).run(uid('u'), username, hashPassword(pw), role, 'active', nowISO(), nowISO());
    mk(process.env.MANAGER_USER || 'admin', process.env.MANAGER_PASSWORD || 'admin123', 'admin', '初始化管理员');
    mk('user', 'user123', 'user', '普通用户演示账号，仅维护映射');
    mk('operator01', 'user123', 'user', '运维同学，仅维护映射');
    mk('dev01', 'user123', 'user', '开发，自助加映射');
    audit('system', '初始化', '管理员账号', '成功');
  }
  const s = db.prepare('SELECT COUNT(*) AS c FROM servers').get();
  if (s.c === 0) {
    const servers = [
      ['srv-bj', '北京主节点', 'frp-bj.example.com', 7000, 'tcp', 'tk_8f3a****', 1, 1, 'office-01', 'bj.example.com', 80, 443, 7401, 'running'],
      ['srv-sh', '上海备份节点', 'frp-sh.example.com', 7000, 'quic', 'tk_2b7c****', 1, 1, 'office-01', 'sh.example.com', 80, 443, 7402, 'running'],
      ['srv-hk', '香港中转（已停）', 'frp-hk.example.net', 7000, 'tcp', 'tk_91dd****', 0, 1, 'office-02', 'hk.example.net', 8080, 8443, 7403, 'stopped']
    ];
    const ins = db.prepare(
      'INSERT INTO servers(id,name,addr,port,protocol,token,tls,mux,user,domain,http_port,https_port,admin_port,status,pid,latency,version,since,created_at,updated_at) ' +
      'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    servers.forEach((x, i) => ins.run(...x, 1201 + i, 18 + i * 7, '0.61.0',
      x[13] === 'running' ? nowISO() : '—', nowISO(), nowISO()));
    const proxies = [
      ['p1', 'srv-bj', 'ssh-office', 'tcp', '192.168.1.22', 22, 20022, null, null, 'server', null, null, 1, 1, null, 1, '办公网跳板机', 'running'],
      ['p2', 'srv-bj', 'web-console', 'http', '127.0.0.1', 8080, null, 'console', null, 'server', null, null, 0, 1, '10MB', 1, '内部控制台', 'running'],
      ['p3', 'srv-bj', 'rdp-dev', 'tcp', '192.168.1.35', 3389, 20389, null, null, 'server', null, null, 1, 0, null, 0, '开发机远程桌面（临时停用）', 'stopped'],
      ['p4', 'srv-sh', 'mysql-sync', 'tcp', '10.0.0.8', 3306, 20022, null, null, 'server', null, null, 1, 1, null, 1, '跨服务端端口可复用', 'running'],
      ['p5', 'srv-sh', 'stcp-nas', 'stcp', '10.0.0.9', 5000, null, null, null, 'server', 'sk_nas****', null, 1, 0, null, 1, '仅允许指定访客访问', 'running'],
      ['p6', 'srv-hk', 'udp-dns', 'udp', '127.0.0.1', 53, 20053, null, null, 'server', null, null, 0, 0, null, 1, '所属实例已停止', 'unknown']
    ];
    const pins = db.prepare(
      'INSERT INTO proxies(id,server_id,name,type,local_ip,local_port,remote_port,subdomain,domains,role,secret_key,bind_port,enc,comp,bw,enabled,remark,state,inb,outb,updated_at) ' +
      'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    proxies.forEach(p => pins.run(...p, 0, 0, nowISO()));
  }
}
function audit(actor, action, target, result) {
  db.prepare('INSERT INTO audit_logs(id,ts,actor,action,target,result) VALUES(?,?,?,?,?,?)')
    .run(uid('a'), nowISO(), actor, action, target, result || '成功');
}

module.exports = { db, DATA_DIR, uid, nowISO, hashPassword, verifyPassword, seed, audit };
