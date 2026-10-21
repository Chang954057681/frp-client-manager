'use strict';
const fs = require('fs');
const path = require('path');
const { db, DATA_DIR } = require('./db');

/* 渲染 common 段（frpc.toml） */
function renderCommon(s) {
  const L = [];
  L.push('# 由 FRP 客户端管理平台生成 · 仅包含 common，极少变动');
  L.push('serverAddr = "' + s.addr + '"');
  L.push('serverPort = ' + s.port);
  if (s.user) L.push('user = "' + s.user + '"');
  L.push('loginFailExit = false');
  L.push('');
  L.push('auth.method = "token"');
  L.push('auth.token = "' + (s.token || '') + '"');
  L.push('');
  L.push('transport.protocol = "' + s.protocol + '"');
  L.push('transport.tcpMux = ' + (s.tls ? 'true' : 'false'));
  L.push('transport.tls.enable = ' + (s.tls ? 'true' : 'false'));
  L.push('transport.heartbeatInterval = 30');
  L.push('');
  L.push('webServer.addr = "127.0.0.1"       # Admin API 仅本地监听');
  L.push('webServer.port = ' + s.admin_port);
  L.push('');
  L.push('log.level = "info"');
  L.push('log.maxDays = 7');
  L.push('');
  L.push('includes = ["/data/servers/' + s.id + '/proxies/*.toml"]');
  return L.join('\n') + '\n';
}

/* 渲染单条映射分片 */
function renderProxy(p) {
  const L = ['[[proxies]]', 'name = "' + p.name + '"', 'type = "' + p.type + '"',
    'localIP = "' + p.local_ip + '"', 'localPort = ' + (p.local_port || 0)];
  if (p.remote_port) L.push('remotePort = ' + p.remote_port);
  if (p.subdomain) L.push('subdomain = "' + p.subdomain + '"');
  if (p.domains) {
    const arr = String(p.domains).split(/[,\s]+/).filter(Boolean).map(d => '"' + d + '"');
    if (arr.length) L.push('customDomains = [' + arr.join(', ') + ']');
  }
  if (['stcp', 'sudp', 'xtcp'].includes(p.type)) {
    L.push('role = "' + (p.role || 'server') + '"');
    if (p.secret_key) L.push('secretKey = "' + p.secret_key + '"');
    if ((p.role || 'server') === 'visitor' && p.server_name) L.push('serverName = "' + p.server_name + '"');
    if ((p.role || 'server') === 'visitor') {
      L.push('bindAddr = "127.0.0.1"');
      if (p.bind_port) L.push('bindPort = ' + p.bind_port);
    }
  }
  if (p.type === 'tcpmux') L.push('multiplexer = "httpconnect"');
  if (p.enc || p.comp || p.bw) {
    L.push('transport.useEncryption = ' + (p.enc ? 'true' : 'false'));
    L.push('transport.useCompression = ' + (p.comp ? 'true' : 'false'));
    if (p.bw) L.push('transport.bandwidthLimit = "' + p.bw + '"');
  }
  return L.join('\n') + '\n';
}

function proxiesOf(sid) {
  return db.prepare('SELECT * FROM proxies WHERE server_id=? AND enabled=1').all(sid);
}

/* 将服务端配置落盘：frpc.toml + proxies/*.toml（原子写：tmp + rename） */
function writeConfigs(server) {
  const dir = path.join(DATA_DIR, 'servers', server.id);
  const pdir = path.join(dir, 'proxies');
  fs.mkdirSync(pdir, { recursive: true });
  const atomic = (file, content) => {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
  };
  atomic(path.join(dir, 'frpc.toml'), renderCommon(server));
  const existing = new Set(fs.readdirSync(pdir).filter(f => f.endsWith('.toml')));
  const keep = new Set();
  proxiesOf(server.id).forEach(p => {
    const f = 'proxy_' + p.id + '.toml';
    atomic(path.join(pdir, f), renderProxy(p));
    keep.add(f);
  });
  // 清理已停用/已删除映射留下的分片
  for (const f of existing) if (!keep.has(f)) fs.rmSync(path.join(pdir, f), { force: true });
  return { dir, count: keep.size };
}

module.exports = { renderCommon, renderProxy, proxiesOf, writeConfigs };
