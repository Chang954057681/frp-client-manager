'use strict';
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

/* ---------- 状态缓存 ---------- */
let me = null, serversCache = [], proxiesCache = [], auditsCache = [];
let settings = { site_name: 'FRP 客户端管理平台', site_short: 'FRP', site_logo: '', site_icon: '' };
let view = 'overview', cfgServer = null, editingProxy = null, editingServer = null, pwdTargetId = null;
let filter = { serverId: 'all', type: 'all', state: 'all', q: '' };

const TYPE_LABEL = { tcp:'TCP', udp:'UDP', http:'HTTP', https:'HTTPS', stcp:'STCP', sudp:'SUDP', xtcp:'XTCP', tcpmux:'TCPMUX' };
const STATE_LABEL = { running:'运行中', stopped:'已停止', error:'异常', unknown:'未知', syncing:'同步中' };

/* ---------- API ---------- */
async function api(method, path, body) {
  const opt = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(path, opt);
  let data = {}; try { data = await r.json(); } catch (e) {}
  if (r.status === 401 && path !== '/api/login') { throw new Error('未登录'); }
  return { ok: r.ok, status: r.status, data };
}
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
const fmtBytes = b => { if (!b) return '0 B'; const u=['B','KB','MB','GB','TB']; let i=0,v=b; while(v>=1024&&i<u.length-1){v/=1024;i++;} return v.toFixed(v<10&&i>0?1:0)+' '+u[i]; };
const isAdmin = () => me && me.role === 'admin';
const serverOf = id => serversCache.find(s => s.id === id);
const hostOf = id => { const s = serverOf(id); return s ? s.domain : ''; };
const normS = s => ({ ...s, tls: !!s.tls, mux: !!s.mux });
const normP = p => ({ ...p, enc: !!p.enc, comp: !!p.comp, enabled: p.enabled !== 0 && p.enabled !== false ? true : !!p.enabled });
const actor = () => me ? me.username : 'admin';

/* ---------- 品牌信息 ---------- */
async function loadSettings() {
  try {
    const r = await api('GET', '/api/settings');
    if (r.ok && r.data.settings) settings = r.data.settings;
  } catch (e) {}
  applyBranding();
}
function applyBranding() {
  const name = settings.site_name || 'FRP 客户端管理平台';
  const short = settings.site_short || 'FRP';
  const logo = settings.site_logo || '';
  document.title = name;
  ['#sideLogo', '#loginLogo'].forEach(sel => {
    const el = $(sel); if (!el) return;
    if (logo) { el.innerHTML = '<img src="' + esc(logo) + '" alt="" />'; el.classList.add('has-img'); }
    else { el.textContent = short; el.classList.remove('has-img'); }
  });
  const sn = $('#sideName'); if (sn) sn.textContent = name;
  const ln = $('#loginName'); if (ln) ln.textContent = name;
  const ic = $('#siteIcon'); if (ic) ic.href = settings.site_icon || 'data:,';
}

/* ---------- toast ---------- */
function toast(title, sub, kind) {
  const el = document.createElement('div'); el.className = 'toast ' + (kind || '');
  el.innerHTML = '<b>' + esc(title) + '</b><div class="s">' + (sub || '') + '</div>';
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.transition='.3s'; el.style.opacity='0'; el.style.transform='translateX(20px)'; }, 4200);
  setTimeout(() => el.remove(), 4600);
}

/* ---------- 弹层 ---------- */
function openEl(el){ $('#mask').classList.add('show'); el.classList.add('show'); }
function closeAll(){ $('#mask').classList.remove('show'); $$('.drawer,.modal').forEach(e=>e.classList.remove('show')); }
document.addEventListener('click', e => { if (e.target.closest('[data-close]')) closeAll(); });
$('#mask').addEventListener('click', closeAll);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAll(); });

/* ---------- 登录 ---------- */
$('#loginForm').onsubmit = async e => {
  e.preventDefault();
  const u = $('#liUser').value.trim(), p = $('#liPass').value;
  const r = await api('POST', '/api/login', { username: u, password: p });
  if (!r.ok) { $('#liErr').textContent = r.data.error || '登录失败'; return; }
  me = r.data.user; $('#liErr').textContent=''; $('#liPass').value=''; bootstrap();
};

/* ---------- 引导 ---------- */
async function bootstrap() {
  $('#loginWrap').classList.remove('show');
  await loadSettings();
  await loadAll();
  $('#app').style.visibility = 'visible'; $('#loading').style.display='none';
  $$('.nav-item[data-role="admin"]').forEach(n => n.style.display = isAdmin() ? '' : 'none');
  render();
}
async function loadAll() {
  const [s, p, a] = await Promise.all([
    api('GET','/api/servers'), api('GET','/api/proxies'), me.role==='admin'?api('GET','/api/audit'):null
  ]);
  serversCache = (s.data.servers || []).map(normS);
  proxiesCache = (p.data.proxies || []).map(normP);
  auditsCache = a && a.data.audits ? a.data.audits : [];
  if (isAdmin()) { const u = await api('GET','/api/users'); window.__users = u.data.users || []; } else window.__users = [];
  if (!cfgServer && serversCache[0]) cfgServer = serversCache[0].id;
}

/* ---------- 热加载流水线动画 ---------- */
function runPipeline(reason, names, actionFn) {
  const steps = [
    { t:'配置校验', d:'校验映射参数与端口占用' },
    { t:'应用配置', d:'生成并下发最新配置' },
    { t:'通知重载', d:'客户端加载最新配置' },
    { t:'确认状态', d:'核对映射运行状态' }
  ];
  $('#pipeTitle').textContent = reason;
  $('#pipeDesc').innerHTML = '正在应用配置变更，已有连接不受影响。';
  $('#pipeSteps').innerHTML = steps.map((st,i)=>'<div class="step pending" data-i="'+i+'"><div class="idx">'+(i+1)+'</div><div class="body"><div class="t">'+esc(st.t)+'</div><div class="d">'+esc(st.d)+'</div></div></div>').join('');
  $('#pipeFoot').innerHTML = '<span class="muted" style="font-size:12px">请稍候…</span>';
  openEl($('#pipeModal'));
  let result = {}; const job = actionFn ? actionFn() : Promise.resolve({});
  let i = 0; const tick = () => {
    const el = $('.step[data-i="'+i+'"]'); if (!el) return;
    el.classList.remove('pending'); el.classList.add('active');
    setTimeout(() => {
      el.classList.remove('active'); el.classList.add('done'); i++;
      if (i < steps.length) setTimeout(tick, 260);
      else job.then(res => { result = res || {}; const ms = result.reload ? result.reload.ms : 0;
        $('#pipeFoot').innerHTML = '<span class="chip"><i class="dot '+(result.ok?'ok':'err')+'"></i>'+
          (result.ok ? ('已生效 · '+(ms||0)+'ms') : ('失败：'+(result.reload&&result.reload.error||'未知'))) +
          '</span><div style="flex:1"></div><button class="btn primary" data-close>完成</button>';
        setTimeout(closeAll, 2200);
      });
    }, 420 + Math.random()*380);
  };
  setTimeout(tick, 200);
  return job;
}

/* ---------- 视图分发 ---------- */
async function render() {
  if (!me) return;
  if (!isAdmin() && ['servers','users'].includes(view)) view = 'proxies';
  $$('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.view === view));
  renderMe();
  $('#navProxyCount').textContent = proxiesCache.length; $('#navProxyCount2').textContent = proxiesCache.length;
  $('#navServerCount').textContent = serversCache.length;
  $('#chipRunning').textContent = serversCache.filter(s=>s.status==='running').length;
  const T = { overview:['概览','系统运行概览'], servers:['服务端实例','服务端连接与实例状态'],
    proxies:['映射管理','映射的创建与维护'], config:['配置预览','查看下发的配置内容'],
    logs:['日志与审计','操作记录'], users:['用户管理','账号与权限管理'] };
  $('#pageTitle').textContent = T[view][0]; $('#pageSub').textContent = T[view][1];
  const c = $('#content');
  if (view==='overview') c.innerHTML = viewOverview();
  else if (view==='servers') c.innerHTML = viewServers();
  else if (view==='proxies') c.innerHTML = viewProxies();
  else if (view==='config') c.innerHTML = await viewConfig();
  else if (view==='logs') c.innerHTML = viewLogs();
  else if (view==='users') c.innerHTML = viewUsers();
  bindViewEvents();
}
function switchView(v){ view=v; render(); }

function renderMe() {
  if (!me) return;
  $('#avatarBtn').textContent = (me.username || '?').trim().charAt(0).toUpperCase();
  $('#meHead').innerHTML = '<b>'+esc(me.username)+'</b><span class="role-chip '+me.role+'">'+esc(isAdmin()?'管理员':'普通用户')+'</span>';
  $$('.me-item[data-role="admin"]').forEach(n => n.style.display = isAdmin() ? '' : 'none');
}

function viewOverview() {
  const running = serversCache.filter(s=>s.status==='running').length;
  const proxRun = proxiesCache.filter(p=>p.state==='running').length;
  const errs = proxiesCache.filter(p=>p.state==='error').length + serversCache.filter(s=>s.status==='error').length;
  const inb = serversCache.reduce((a,s)=>a+(s.traffic_in||0),0), outb = serversCache.reduce((a,s)=>a+(s.traffic_out||0),0);
  const pts = Array.from({length:24},(_,i)=>Math.max(6,Math.round(40+Math.sin(i/2.4)*22+Math.cos(i/1.3)*10+(i%5)*6)));
  const max = Math.max(...pts);
  const poly = pts.map((v,i)=>(i*(100/23)).toFixed(2)+','+(100-(v/max)*88).toFixed(2)).join(' ');
  const stat=(l,v,f,b)=>'<div class="card stat"><div class="bar '+(b||'')+'"></div><div class="label">'+l+'</div><div class="value">'+v+'</div><div class="foot">'+f+'</div></div>';
  return '<div class="card banner"><div class="hero-note"><i class="dot info" style="margin-top:4px"></i><div><b>映射变更在线生效</b>：保存后自动应用，不影响其它已有映射与连接。</div></div></div>'+
  '<div class="grid g4" style="margin-bottom:14px">'+stat('服务端实例',serversCache.length,running+' 个运行中',isAdmin()?'accent':'info')+
    stat('在线映射',proxRun,'共 '+proxiesCache.length+' 条', 'ok')+stat('累计出流量',fmtBytes(outb),'累计入流量 '+fmtBytes(inb),'accent')+
    stat('异常项',errs,errs?'需处理':'全部正常',errs?'err':'ok')+'</div>'+
  '<div class="grid g2" style="margin-bottom:14px">'+
    '<div class="card"><div class="card-h"><h3>近 24 小时流量</h3></div><div class="card-b"><svg class="chart" viewBox="0 0 100 100" preserveAspectRatio="none">'+
      '<defs><linearGradient id="g1" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--accent)" stop-opacity=".45"/><stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>'+
      '<polygon points="0,100 '+poly+' 100,100" fill="url(#g1)"/><polyline points="'+poly+'" fill="none" stroke="var(--accent)" stroke-width="1.2" vector-effect="non-scaling-stroke"/></svg></div></div>'+
    '<div class="card"><div class="card-h"><h3>实例健康</h3></div><div class="card-b" style="padding:8px 16px 16px">'+
      serversCache.map(s=>'<div class="kv" style="padding:9px 0;border-bottom:1px solid var(--border-soft)"><span style="display:flex;gap:8px;align-items:center"><i class="dot '+(s.status==='running'?'ok':s.status==='error'?'err':'')+'"></i><span style="color:var(--text)">'+esc(s.name)+'</span><span class="muted mono">'+(isAdmin()?esc(s.addr)+':'+s.port:'已脱敏')+'</span></span><span>'+(s.status==='running'?(s.traffic_out?('延迟 '+(s.latency||'?')+'ms · '+fmtBytes(s.traffic_in||0)+'↓ / '+fmtBytes(s.traffic_out||0)+'↑'):('延迟 '+(s.latency||'?')+'ms')):'已停止')+'</span></div>').join('')+
    '</div></div></div>'+
  '<div class="card"><div class="card-h"><h3>最近操作</h3><div class="right"><button class="btn sm" data-view="logs">查看全部</button></div></div><table><thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>对象</th><th>结果</th></tr></thead><tbody>'+
    auditsCache.slice(0,5).map(a=>'<tr><td class="mono muted">'+esc(a.ts)+'</td><td>'+esc(a.actor)+'</td><td>'+esc(a.action)+'</td><td class="mono">'+esc(a.target)+'</td><td><span class="chip"><i class="dot ok"></i>'+esc(a.result)+'</span></td></tr>').join('')+
  '</tbody></table></div>';
}

function viewServers() {
  if (!isAdmin()) {
    return '<div class="readonly-note"><i class="dot warn"></i>当前角色为普通用户，服务端连接信息与实例启停仅管理员可操作。你仍可在「映射管理」中选择归属服务端并维护映射。</div>'+
    '<div class="grid g3">'+serversCache.map(s=>'<div class="card server-card"><div class="top"><i class="dot '+(s.status==='running'?'ok':s.status==='error'?'err':'')+'"></i><div><div class="name">'+esc(s.name)+'</div><div class="meta">已脱敏 · '+esc(s.protocol.toUpperCase())+'</div></div><div style="margin-left:auto"><span class="chip">'+STATE_LABEL[s.status]||'已停止'+'</span></div></div><div>'+kv('映射数',(s.proxyRunning||0)+' / '+(s.proxyCount||0)+' 在线')+kv('frpc 版本',esc(s.version||'?'))+'</div><div class="actions"><button class="btn sm locked" disabled>编辑</button><button class="btn sm locked" disabled>启停</button><button class="btn sm locked" disabled>删除</button></div></div>').join('')+'</div>';
  }
  return '<div class="toolbar"><span class="chip">共 '+serversCache.length+' 个服务端</span><div class="spacer"></div><button class="btn primary" data-act="new-server">+ 新增服务端</button></div>'+
  '<div class="grid g3">'+serversCache.map(s=>{const cnt=s.proxyCount||0,run=s.proxyRunning||0,st=s.status;return '<div class="card server-card"><div class="top"><i class="dot '+(st==='running'?'ok':st==='error'?'err':'')+'"></i><div><div class="name">'+esc(s.name)+'</div><div class="meta">'+esc(s.addr)+':'+s.port+' · '+esc(s.protocol.toUpperCase())+'</div></div><div style="margin-left:auto"><span class="chip">'+STATE_LABEL[st]+'</span></div></div><div>'+
    kv('frpc 版本',esc(s.version||'?'))+kv('进程 PID',s.pid||'—')+kv('Admin 端口','127.0.0.1:'+s.admin_port)+kv('映射数',run+' / '+cnt+' 在线')+
    kv('延迟',s.latency!=null?s.latency+' ms':'—')+kv('绑定域名',esc(s.domain||'—'))+kv('HTTP/HTTPS 端口',(s.http_port||80)+' / '+(s.https_port||443))+kv('认证 Token',esc(s.token||'—'))+
    '</div><div class="actions">'+(st==='running'?'<button class="btn sm" data-act="stop-server" data-id="'+s.id+'">停止</button><button class="btn sm" data-act="restart-server" data-id="'+s.id+'">重启</button>':'<button class="btn sm primary" data-act="start-server" data-id="'+s.id+'">启动</button>')+
    '<button class="btn sm" data-act="edit-server" data-id="'+s.id+'">编辑</button><button class="btn sm" data-act="cfg-server" data-id="'+s.id+'">配置</button><button class="btn sm" data-act="log-server" data-id="'+s.id+'">日志</button><button class="btn sm danger" data-act="del-server" data-id="'+s.id+'">删除</button></div></div>';}).join('')+'</div>';
}
const kv=(k,v)=>'<div class="kv"><span>'+k+'</span><span>'+v+'</span></div>';

function viewProxies() {
  const f = filter;
  const list = proxiesCache.filter(p =>
    (f.serverId==='all'||p.server_id===f.serverId) && (f.type==='all'||p.type===f.type) &&
    (f.state==='all'||p.state===f.state) && (!f.q||(p.name+p.remark+p.local_ip).toLowerCase().includes(f.q.toLowerCase())));
  const opt=(v,t,sel)=>'<option value="'+v+'"'+(sel?' selected':'')+'>'+t+'</option>';
  return '<div class="toolbar"><select id="fServer">'+opt('all','全部服务端',f.serverId==='all')+serversCache.map(s=>opt(s.id,esc(s.name),f.serverId===s.id)).join('')+'</select>'+
    '<select id="fType">'+opt('all','全部协议',f.type==='all')+Object.keys(TYPE_LABEL).map(t=>opt(t,TYPE_LABEL[t],f.type===t)).join('')+'</select>'+
    '<select id="fState">'+opt('all','全部状态',f.state==='all')+Object.keys(STATE_LABEL).filter(k=>k!=='syncing').map(k=>opt(k,STATE_LABEL[k],f.state===k)).join('')+'</select>'+
    '<input type="text" id="fQ" placeholder="搜索名称 / 备注 / IP" value="'+esc(f.q)+'" style="min-width:200px"/>'+
    '<div class="spacer"></div><span class="chip">'+list.length+' 条</span>'+
    '<button class="btn" data-act="import-proxy">导入</button><button class="btn" data-act="export-proxy">导出</button>'+
    '<button class="btn primary" data-act="new-proxy">+ 新增映射</button></div>'+
  '<div class="card">'+(list.length?'<table><thead><tr><th>状态</th><th>名称</th><th>类型</th><th>本地地址</th><th>远端</th><th>当前域名</th><th>所属服务端</th><th>更新时间</th><th style="text-align:right">操作</th></tr></thead><tbody>'+
    list.map(p=>{const s=serverOf(p.server_id);const dot=p.state==='running'?'ok':p.state==='error'?'err':p.state==='syncing'?'info pulse':'';return '<tr><td><span class="chip"><i class="dot '+dot+'"></i>'+STATE_LABEL[p.state]+'</span></td><td><div style="font-weight:600">'+esc(p.name)+'</div>'+(p.remark?'<div class="muted" style="font-size:11.5px">'+esc(p.remark)+'</div>':'')+'</td><td><span class="tag">'+TYPE_LABEL[p.type]+'</span></td><td class="mono">'+esc(p.local_ip)+':'+(p.local_port||'-')+'</td><td class="mono">'+remoteDesc(p)+'</td><td class="mono">'+currentDomain(p)+'</td><td>'+(s?esc(s.name):'—')+'</td><td class="mono muted nowrap">'+esc(p.updated_at||'')+'</td><td class="nowrap" style="text-align:right"><button class="btn sm" data-act="toggle" data-id="'+p.id+'">'+(p.enabled?'停用':'启用')+'</button> <button class="btn sm" data-act="edit" data-id="'+p.id+'">编辑</button> <button class="btn sm danger" data-act="del" data-id="'+p.id+'">删除</button></td></tr>';}).join('')+
  '</tbody></table>':'<div class="empty">没有符合条件的映射</div>')+'</div>';
}
function remoteDesc(p){
  if (['tcp','udp','tcpmux'].includes(p.type)) return ':'+(p.remote_port||'-');
  if (['http','https'].includes(p.type)){const s=serverOf(p.server_id);const base=s?s.domain:'';const port=s?(p.type==='https'?s.https_port:s.http_port):(p.type==='https'?443:80);if(p.subdomain)return (base?p.subdomain+'.'+base:p.subdomain+'.*')+':'+port;if(p.domains)return p.domains.split(/[,\s]+/)[0]+':'+port;return ':'+port;}
  if (p.domains) return p.domains.split(/[,\s]+/)[0]; if (p.secret_key) return 'sk:****'; return '-';
}
function currentDomain(p){
  if (!['http','https'].includes(p.type)) return '<span class="muted">—</span>';
  const s=serverOf(p.server_id);const base=s?s.domain:'';
  if (p.subdomain) return '<span class="tag">'+(base?esc(p.subdomain+'.'+base):esc(p.subdomain+'.*'))+'</span>';
  if (p.domains) return '<span class="tag">'+esc(p.domains.split(/[,\s]+/)[0])+'</span>';
  return '<span class="muted">未配置</span>';
}

async function viewConfig() {
  const s = serverOf(cfgServer) || serversCache[0]; if (!s) return '<div class="empty">无服务端</div>';
  cfgServer = s.id;
  let common='', proxies=[], previewMode=!isAdmin();
  if (isAdmin()) { const r = await api('GET','/api/servers/'+s.id+'/config'); common=r.data.common||''; proxies=r.data.proxies||[]; }
  else { const r = await api('GET','/api/servers/'+s.id+'/preview'); proxies=(r.data.proxies||[]).map(renderProxyPreview); }
  const hl = t => esc(t).replace(/^#.*$/gm,m=>'<span class="c">'+m+'</span>').replace(/^\[\[?[^\]]+\]\]?$/gm,'<span class="tk">$1</span>').replace(/^([A-Za-z][\w.]*)(?= =)/gm,'<span class="k">$1</span>').replace(/= ("[^"]*")/g,'= <span class="s">$1</span>').replace(/= (true|false)/g,'= <span class="b">$1</span>').replace(/= (\d+)/g,'= <span class="n">$1</span>');
  const cfgSelect = '<select id="cfgServer">'+serversCache.map(x=>'<option value="'+x.id+'"'+(x.id===s.id?' selected':'')+'>'+esc(x.name)+'</option>').join('')+'</select>';
  if (previewMode) {
    return '<div class="toolbar">'+cfgSelect+'<div class="spacer"></div><span class="chip"><i class="dot warn"></i> 仅显示映射分片</span></div>'+
      '<div class="readonly-note"><i class="dot warn"></i>连接地址与认证凭据仅管理员可见。</div>'+
      '<div class="card"><div class="card-h"><h3>映射分片（includes）</h3><div class="right"><span class="chip">'+proxies.length+' 个分片</span></div></div><div class="card-b" style="padding:12px">'+
      (proxies.length?proxies.map(p=>'<pre class="code" style="max-height:none">'+p+'</pre>').join(''):'<div class="empty">该服务端下暂无启用中的映射</div>')+'</div></div>';
  }
  return '<div class="toolbar">'+cfgSelect+'<div class="spacer"></div>'+
    '<button class="btn sm" data-act="copy-cfg">复制合并配置</button><button class="btn sm" data-act="export-cfg">导出</button></div>'+
    '<div class="grid g2"><div class="card"><div class="card-h"><h3>frpc.toml</h3><div class="right"><span class="chip">common 变更需重启</span></div></div><div class="card-b" style="padding:12px"><pre class="code">'+hl(common)+'</pre></div></div>'+
    '<div class="card"><div class="card-h"><h3>映射分片（includes）</h3><div class="right"><span class="chip">'+proxies.length+' 个分片</span></div></div><div class="card-b" style="padding:12px">'+
    (proxies.length?proxies.map(p=>'<pre class="code" style="max-height:none">'+hl(p)+'</pre>').join(''):'<div class="empty">该服务端下暂无启用中的映射</div>')+'</div></div></div>';
}
function renderProxyPreview(p){
  const L=['[[proxies]]','name = "'+p.name+'"','type = "'+p.type+'"','localIP = "'+p.local_ip+'"','localPort = '+(p.local_port||0)];
  if (p.remote_port) L.push('remotePort = '+p.remote_port);
  if (p.subdomain) L.push('subdomain = "'+p.subdomain+'"');
  if (p.domains){const a=String(p.domains).split(/[,\s]+/).filter(Boolean).map(d=>'"'+d+'"');if(a.length)L.push('customDomains = ['+a.join(', ')+']');}
  if (['stcp','sudp','xtcp'].includes(p.type)){L.push('role = "'+(p.role||'server')+'"');if(p.secret_key)L.push('secretKey = "***"');}
  if (p.enc||p.comp||p.bw){L.push('transport.useEncryption = '+(p.enc?'true':'false'));L.push('transport.useCompression = '+(p.comp?'true':'false'));if(p.bw)L.push('transport.bandwidthLimit = "'+p.bw+'"');}
  return '<div style="margin-bottom:12px"><div class="muted mono" style="font-size:11.5px;margin-bottom:5px">proxy_'+p.id+'.toml</div><pre class="code" style="max-height:none">'+esc(L.join('\n'))+'</pre></div>';
}

function viewLogs() {
  const audits = isAdmin() ? auditsCache : auditsCache.filter(a=>a.actor===me.username);
  return '<div class="card"><div class="card-h"><h3>操作日志</h3><span class="desc">'+(isAdmin()?'全部记录':'仅显示本人操作')+'</span></div>'+
    (audits.length?'<table><thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>对象</th></tr></thead><tbody>'+audits.map(a=>'<tr><td class="mono muted nowrap">'+esc(a.ts)+'</td><td>'+esc(a.actor)+'</td><td>'+esc(a.action)+'</td><td class="mono">'+esc(a.target)+'</td></tr>').join('')+'</tbody></table>':'<div class="empty">暂无记录</div>')+'</div>';
}
function viewUsers() {
  return '<div class="toolbar"><span class="chip">共 '+(window.__users?window.__users.length:0)+' 个账号</span><div class="spacer"></div><button class="btn primary" data-act="new-user">+ 新增用户</button></div>'+
  '<div class="card"><table><thead><tr><th>账号</th><th>角色</th><th>可操作范围</th><th>最近登录</th><th>备注</th><th style="text-align:right">操作</th></tr></thead><tbody>'+
    (window.__users||[]).map(u=>'<tr><td class="mono" style="font-weight:600">'+esc(u.username)+(me&&u.username===me.username?' <span class="muted" style="font-weight:400">（我）</span>':'')+'</td><td><span class="role-chip '+u.role+'">'+esc(u.role==='admin'?'管理员':'普通用户')+'</span></td><td class="muted">'+(u.role==='admin'?'服务端 + 映射 + 用户':'仅映射（CRUD / 启停）')+'</td><td class="mono muted nowrap">'+esc(u.last_login_at||'—')+'</td><td class="muted">'+esc(u.remark||'')+'</td><td class="nowrap" style="text-align:right"><button class="btn sm" data-act="set-pwd" data-id="'+u.id+'">修改密码</button> '+(u.username==='admin'?'<button class="btn sm locked" disabled>删除</button>':'<button class="btn sm danger" data-act="del-user" data-id="'+u.id+'">删除</button>')+'</td></tr>').join('')+
  '</tbody></table></div>';
}

/* ---------- 事件绑定 ---------- */
function bindViewEvents() {
  if (view==='proxies') {
    $('#fServer').onchange=e=>{filter.serverId=e.target.value;render();};
    $('#fType').onchange=e=>{filter.type=e.target.value;render();};
    $('#fState').onchange=e=>{filter.state=e.target.value;render();};
    $('#fQ').oninput=e=>{filter.q=e.target.value;const v=e.target.value,n=$('#fQ');render();const m=$('#fQ');if(m){m.focus();m.setSelectionRange(v.length,v.length);}};
  }
  if (view==='config') $('#cfgServer').onchange=e=>{cfgServer=e.target.value;render();};
}
$$('.nav-item').forEach(n=>n.onclick=()=>switchView(n.dataset.view));
document.addEventListener('click', e=>{ const b=e.target.closest('[data-view]'); if(b && !b.classList.contains('nav-item')) switchView(b.dataset.view); });
$('#btnNewProxy').onclick=()=>{switchView('proxies');proxyForm(null);};
$('#btnTheme').onclick=()=>{const r=document.documentElement;r.dataset.theme=r.dataset.theme==='dark'?'light':'dark';};

/* ---------- 头像菜单 ---------- */
$('#avatarBtn').onclick = e => { e.stopPropagation(); $('#userMenu').classList.toggle('open'); };
document.addEventListener('click', e => { if (!e.target.closest('#userMenu')) $('#userMenu').classList.remove('open'); });

/* ---------- 本人改密 ---------- */
function openPwd() {
  ['#pwOld','#pwNew','#pwNew2'].forEach(s=>$(s).value='');
  $('#pwErr').textContent=''; openEl($('#pwdModal')); setTimeout(()=>$('#pwOld').focus(),80);
}
$('#btnSavePwd').onclick = async () => {
  const o=$('#pwOld').value, n=$('#pwNew').value, n2=$('#pwNew2').value;
  if (!o) return $('#pwErr').textContent='请输入当前密码';
  if (n.length<6) return $('#pwErr').textContent='新密码长度至少 6 位';
  if (n!==n2) return $('#pwErr').textContent='两次输入的新密码不一致';
  const r = await api('POST','/api/me/password',{oldPassword:o,newPassword:n});
  if (!r.ok) return $('#pwErr').textContent = r.data.error||'修改失败';
  closeAll(); toast('密码已修改','请使用新密码登录');
};

/* ---------- 管理员为指定账号改密 ---------- */
function openSetPwd(id) {
  const u = (window.__users||[]).find(x=>x.id===id); if (!u) return;
  pwdTargetId = id;
  $('#spTitle').textContent = '修改密码 · ' + u.username;
  $('#spNew').value=''; $('#spNew2').value=''; $('#spErr').textContent='';
  openEl($('#setPwdModal')); setTimeout(()=>$('#spNew').focus(),80);
}
$('#btnSaveSetPwd').onclick = async () => {
  const n=$('#spNew').value, n2=$('#spNew2').value;
  if (n.length<6) return $('#spErr').textContent='密码长度至少 6 位';
  if (n!==n2) return $('#spErr').textContent='两次输入的密码不一致';
  const r = await api('PUT','/api/users/'+pwdTargetId+'/password',{password:n});
  if (!r.ok) return $('#spErr').textContent = r.data.error||'修改失败';
  closeAll(); toast('密码已更新','该账号下次登录请使用新密码');
};

/* ---------- 新增用户 ---------- */
function openNewUser() {
  $('#nuUser').value=''; $('#nuPass').value=''; $('#nuRole').value='user'; $('#nuRemark').value=''; $('#nuErr').textContent='';
  openEl($('#userModal')); setTimeout(()=>$('#nuUser').focus(),80);
}
$('#btnSaveUser').onclick = async () => {
  const username=$('#nuUser').value.trim(), password=$('#nuPass').value;
  if (!username) return $('#nuErr').textContent='请输入账号';
  if (password.length<6) return $('#nuErr').textContent='密码长度至少 6 位';
  const r = await api('POST','/api/users',{username,password,role:$('#nuRole').value,remark:$('#nuRemark').value.trim()});
  if (!r.ok) return $('#nuErr').textContent = r.data.error||'创建失败';
  closeAll(); toast('用户已创建', username); loadAll().then(render);
};

/* ---------- 平台设置（品牌） ---------- */
function prevBrand() {
  const short = ($('#brShort').value.trim()||'FRP'), logo = $('#brLogo').value.trim();
  const el = $('#brPrevLogo');
  if (logo) { el.innerHTML = '<img src="'+esc(logo)+'" alt="" />'; el.classList.add('has-img'); }
  else { el.textContent = short; el.classList.remove('has-img'); }
  $('#brPrevName').textContent = $('#brName').value.trim() || 'FRP 客户端管理平台';
}
function openBrand() {
  $('#brName').value = settings.site_name||''; $('#brShort').value = settings.site_short||'';
  $('#brLogo').value = settings.site_logo||''; $('#brIcon').value = settings.site_icon||'';
  $('#brErr').textContent=''; prevBrand(); openEl($('#brandModal'));
}
['#brName','#brShort','#brLogo'].forEach(s=>{ const el=$(s); if(el) el.oninput=prevBrand; });
$('#btnSaveBrand').onclick = async () => {
  const r = await api('PUT','/api/settings',{
    site_name:$('#brName').value.trim(), site_short:$('#brShort').value.trim()||'FRP',
    site_logo:$('#brLogo').value.trim(), site_icon:$('#brIcon').value.trim()
  });
  if (!r.ok) return $('#brErr').textContent = r.data.error||'保存失败';
  settings = r.data.settings || settings; applyBranding(); closeAll();
  toast('平台设置已保存','名称 / Logo / 图标已更新');
};

/* ---------- 映射表单 ---------- */
function proxyForm(p) {
  p = p || { server_id: filter.serverId!=='all'?filter.serverId:(serversCache[0]&&serversCache[0].id), type:'tcp', local_ip:'127.0.0.1', role:'server', enc:true, comp:true, enabled:true };
  editingProxy = p;
  $('#drawerTitle').textContent = p.id ? '编辑映射 · '+p.name : '新增映射';
  const sopt = serversCache.map(s=>'<option value="'+s.id+'"'+(s.id===(p.server_id||'')?' selected':'')+'>'+esc(s.name)+(isAdmin()?' ('+esc(s.addr)+')':'')+(s.status!=='running'?' · 已停止':'')+'</option>').join('');
  $('#drawerBody').innerHTML =
    '<div class="field"><label>所属服务端（决定由哪个 frpc 实例承载）</label><select id="pServer">'+sopt+'</select>'+(isAdmin()?'':'<div class="hint">选择该映射由哪个服务端承载（连接信息由管理员维护）</div>')+'</div>'+
    '<div class="row2"><div class="field"><label>映射名称（服务端内唯一）</label><input type="text" id="pName" value="'+esc(p.name||'')+'" placeholder="ssh-office"/></div>'+
    '<div class="field"><label>协议类型</label><select id="pType">'+Object.keys(TYPE_LABEL).map(t=>'<option value="'+t+'"'+(p.type===t?' selected':'')+'>'+TYPE_LABEL[t]+'</option>').join('')+'</select></div></div>'+
    '<div class="row2"><div class="field"><label>本地 IP</label><input type="text" id="pLocalIp" value="'+esc(p.local_ip||'')+'" placeholder="127.0.0.1"/></div>'+
    '<div class="field"><label>本地端口</label><input type="number" id="pLocalPort" value="'+(p.local_port||'')+'" placeholder="22"/></div></div>'+
    '<div id="advFields"></div>'+
    '<div class="field"><label>带宽限制（可选）</label><input type="text" id="pBw" value="'+esc(p.bw||'')+'" placeholder="10MB（留空不限）"/></div>'+
    '<div style="display:flex;gap:26px;flex-wrap:wrap;margin:4px 0 10px"><label class="switch"><input type="checkbox" id="pEnc"'+(p.enc?' checked':'')+'><i class="track"></i><span>启用加密</span></label><label class="switch"><input type="checkbox" id="pComp"'+(p.comp?' checked':'')+'><i class="track"></i><span>启用压缩</span></label><label class="switch"><input type="checkbox" id="pEnabled"'+(p.enabled!==false?' checked':'')+'><i class="track"></i><span>立即启用</span></label></div>'+
    '<div class="field"><label>备注</label><input type="text" id="pRemark" value="'+esc(p.remark||'')+'" placeholder="用途说明"/></div>'+
    '<div class="hero-note"><i class="dot info" style="margin-top:4px"></i><div>保存后立即生效，无需重启客户端。</div></div>';
  const sync = () => {
    const t=$('#pType').value; const host=hostOf($('#pServer').value);
    $('#advFields').innerHTML =
      (['tcp','udp','tcpmux'].includes(t)?'<div class="field"><label>远程端口（同一服务端内唯一）</label><input type="number" id="pRemote" value="'+(p.remote_port||'')+'" placeholder="20022"/><div class="hint">平台提交前检测端口冲突；如需自动分配可留空后由端口池分配。</div></div>':'')+
      (['http','https'].includes(t)?'<div class="field"><label>服务端绑定域名（自动带出）</label><input type="text" id="pHost" value="'+esc(host)+'" readonly/><div class="hint">该域名已在服务端「'+esc(serverOf($('#pServer').value).name)+'」绑定（管理端配置）</div></div>'+
        '<div class="field"><label>子域名前缀（自定义）</label><input type="text" id="pSub" value="'+esc(p.subdomain||'')+'" placeholder="console" oninput="updPrev()"/><div class="hint">最终访问域名：<span class="mono" id="pPreview">'+(p.subdomain?p.subdomain+'.'+host:'前缀.'+host)+'</span></div></div>'+
        '<div class="field"><label>附加自定义域名（可选，逗号分隔）</label><input type="text" id="pDomains" value="'+esc(p.domains||'')+'" placeholder="a.example.com"/></div>':'')+
      (['stcp','sudp','xtcp'].includes(t)?'<div class="row2"><div class="field"><label>角色</label><select id="pRole"><option value="server"'+(p.role!=='visitor'?' selected':'')+'>服务端（被访问）</option><option value="visitor"'+(p.role==='visitor'?' selected':'')+'>访客（主动访问）</option></select></div><div class="field"><label>secretKey</label><input type="text" id="pSk" value="'+esc(p.secret_key||'')+'" placeholder="仅双方一致才可建立隧道"/></div></div>'+(p.role==='visitor'?'<div class="row2"><div class="field"><label>引用映射名</label><input type="text" id="pSrvName" value="'+esc(p.server_name||'')+'" placeholder="stcp-nas"/></div><div class="field"><label>本地监听端口</label><input type="number" id="pBind" value="'+(p.bind_port||'')+'" placeholder="6000"/></div></div>':''):'');
    const r=$('#pRole'); if(r) r.onchange=sync;
  };
  sync(); $('#pType').onchange=sync;
  $('#pServer').onchange=()=>{const h=hostOf($('#pServer').value);const ph=$('#pHost');if(ph){ph.value=h;updPrev();}};
  updPrev(); openEl($('#drawer'));
}
window.updPrev=function(){const sub=$('#pSub'),host=$('#pHost');if(!sub||!host)return;$('#pPreview').textContent=(sub.value.trim()?sub.value.trim()+'.'+host.value:'前缀.'+host.value);};
function collectProxy() {
  const g=id=>{const e=$(id);return e?e.value:undefined};const num=id=>{const v=g(id);return v===''||v==null?undefined:Number(v);};
  return { id:editingProxy&&editingProxy.id, server_id:g('#pServer'), name:(g('#pName')||'').trim(), type:g('#pType'), local_ip:(g('#pLocalIp')||'').trim(),
    local_port:num('#pLocalPort'), remote_port:num('#pRemote'), subdomain:(g('#pSub')||'').trim(), domains:(g('#pDomains')||'').trim(),
    role:g('#pRole'), secret_key:g('#pSk'), server_name:g('#pSrvName'), bind_port:num('#pBind'), enc:$('#pEnc').checked, comp:$('#pComp').checked,
    enabled:$('#pEnabled').checked, bw:(g('#pBw')||'').trim(), remark:(g('#pRemark')||'').trim() };
}
$('#btnSaveProxy').onclick=async()=>{
  const p=collectProxy(); const isNew=!p.id;
  const r=await api(isNew?'POST':'PUT', isNew?'/api/proxies':'/api/proxies/'+p.id, p);
  if (!r.ok) { toast('校验未通过', r.data.error||'保存失败', 'err'); return; }
  closeAll();
  runPipeline((isNew?'新增映射 ':'修改映射 ')+p.name, [p.name], async()=>r).then(res=>{
    toast(isNew?'映射已新增并生效':'映射已更新并生效', '已生效 '+(res.reload?res.reload.ms:0)+'ms');
    loadAll().then(render);
  });
};

/* ---------- 服务端表单 ---------- */
function serverForm(s) {
  s = s || { port:7000, protocol:'tcp', tls:true, mux:true, status:'stopped' }; editingServer=s;
  $('#smTitle').textContent = s.id ? '编辑服务端 · '+s.name : '新增服务端';
  const popt=['tcp','kcp','quic','websocket','wss'].map(x=>'<option value="'+x+'"'+(s.protocol===x?' selected':'')+'>'+x.toUpperCase()+'</option>').join('');
  $('#smBody').innerHTML =
    '<div class="field"><label>名称</label><input type="text" id="sName" value="'+esc(s.name||'')+'"/></div>'+
    '<div class="row2"><div class="field"><label>服务端地址</label><input type="text" id="sAddr" value="'+esc(s.addr||'')+'"/></div><div class="field"><label>服务端端口</label><input type="number" id="sPort" value="'+(s.port||7000)+'"/></div></div>'+
    '<div class="row2"><div class="field"><label>传输协议</label><select id="sProto">'+popt+'</select></div><div class="field"><label>认证 Token</label><input type="text" id="sToken" value="'+esc(s.token||'')+'"/></div></div>'+
    '<div class="row2"><div class="field"><label>用户前缀（可选）</label><input type="text" id="sUser" value="'+esc(s.user||'')+'"/></div><div class="field"><label>Admin 端口</label><input type="number" id="sAdmin" value="'+(s.admin_port||7401)+'"/><div class="hint">仅监听 127.0.0.1，用于热加载。</div></div></div>'+
    '<div class="field"><label>绑定域名（子域名后缀，如 example.com）</label><input type="text" id="sDomain" value="'+esc(s.domain||'')+'" placeholder="bj.example.com"/><div class="hint">新增 HTTP/HTTPS 映射时自动带出，用户只需填前缀。</div></div>'+
    '<div class="row2"><div class="field"><label>HTTP 端口（vhost）</label><input type="number" id="sHttp" value="'+(s.http_port||80)+'"/></div><div class="field"><label>HTTPS 端口（vhost）</label><input type="number" id="sHttps" value="'+(s.https_port||443)+'"/></div></div>'+
    '<div style="display:flex;gap:26px;flex-wrap:wrap;margin:4px 0 10px"><label class="switch"><input type="checkbox" id="sTls"'+(s.tls!==false?' checked':'')+'><i class="track"></i><span>启用 TLS</span></label><label class="switch"><input type="checkbox" id="sMux"'+(s.mux!==false?' checked':'')+'><i class="track"></i><span>多路复用</span></label></div>'+
    '<div class="hero-note"><i class="dot warn" style="margin-top:4px"></i><div>修改连接地址、Token 或传输参数需重启该实例，其他实例不受影响。</div></div>';
  openEl($('#serverModal'));
}
$('#btnSaveServer').onclick=async()=>{
  const v={name:($('#sName').value||'').trim(),addr:($('#sAddr').value||'').trim(),port:Number($('#sPort').value)||7000,protocol:$('#sProto').value,token:$('#sToken').value,user:$('#sUser').value.trim(),admin_port:Number($('#sAdmin').value)||7401,domain:$('#sDomain').value.trim(),http_port:Number($('#sHttp').value)||80,https_port:Number($('#sHttps').value)||443,tls:$('#sTls').checked,mux:$('#sMux').checked};
  if (!v.name||!v.addr){toast('校验未通过','名称与服务端地址为必填项','err');return;}
  const s=editingServer;
  const r = s && s.id ? await api('PUT','/api/servers/'+s.id,v) : await api('POST','/api/servers',v);
  if (!r.ok){toast('保存失败',r.data.error||'','err');return;}
  closeAll(); await loadAll(); render();
  toast(s&&s.id?'服务端已保存':'服务端已新增', r.data.commonChanged?'common 变更已重启实例':'实例已就绪');
};

/* ---------- 导入 / 导出 ---------- */
$('#btnDoImport').onclick=async()=>{
  const txt=$('#ioText').value.trim(); if(!txt){toast('没有内容','请选择文件或粘贴 JSON','err');return;}
  let arr; try{const parsed=JSON.parse(txt);arr=Array.isArray(parsed)?parsed:parsed.proxies;if(!Array.isArray(arr))throw 0;}catch(e){toast('JSON 解析失败','顶层需为数组或含 proxies 数组','err');return;}
  const r=await api('POST','/api/import',{proxies:arr});
  if(!r.ok){toast('导入失败',r.data.error||'','err');return;}
  closeAll(); await loadAll(); render();
  toast('导入完成','新增 '+r.data.added+' 条，跳过 '+r.data.skipped+' 条');
};

/* ---------- 全局点击委托 ---------- */
const ADMIN=['new-server','edit-server','start-server','stop-server','restart-server','del-server','log-server','del-user','new-user','set-pwd','branding'];
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const act=b.dataset.act, id=b.dataset.id;
  $('#userMenu').classList.remove('open');
  if (!me) return;
  if (ADMIN.includes(act) && !isAdmin()) { toast('403 · 需要管理员权限','该操作仅限管理员','err'); return; }
  if (act==='logout'){ await api('POST','/api/logout'); me=null; $('#app').style.visibility='hidden'; $('#loginWrap').classList.add('show'); return; }
  if (act==='change-pwd') return openPwd();
  if (act==='branding') return openBrand();
  if (act==='new-proxy') return proxyForm(null);
  if (act==='edit') return proxyForm(proxiesCache.find(p=>p.id===id));
  if (act==='new-server') return serverForm(null);
  if (act==='edit-server') return serverForm(serversCache.find(s=>s.id===id));
  if (act==='cfg-server'){ cfgServer=id; switchView('config'); return; }
  if (act==='export-proxy'){ const r=await api('GET','/api/export'); download('frpc-proxies.json', JSON.stringify(r.data,null,2)); toast('已导出映射',(r.data.proxies||[]).length+' 条映射已下载'); return; }
  if (act==='import-proxy'){ $('#ioBody').innerHTML='<input type="file" id="ioFile" accept=".json,application/json" style="margin-bottom:10px;width:100%"/><div class="hint" style="margin-bottom:8px">结构：<code class="mono">{"proxies":[{ "name","type","serverName" 或 "serverId",... }]}</code>。服务端按名称/id 匹配；同名自动重命名；校验失败跳过。</div><textarea id="ioText" rows="13" placeholder=\'{"proxies":[{"name":"demo","type":"tcp","serverName":"北京主节点","localIp":"127.0.0.1","localPort":22,"remotePort":20022}]}\'></textarea>';
    $('#ioFile').onchange=ev=>{const f=ev.target.files[0];if(!f)return;const rd=new FileReader();rd.onload=()=>{$('#ioText').value=rd.result;};rd.readAsText(f);}; openEl($('#ioModal')); return; }
  if (act==='copy-cfg'){ const r=await api('GET','/api/servers/'+cfgServer+'/config'); navigator.clipboard&&navigator.clipboard.writeText(r.data.common+'\n\n'+(r.data.proxies||[]).join('\n\n')); toast('已复制合并配置','可直接用于 frpc 客户端'); return; }
  if (act==='export-cfg'){ toast('已生成导出文件','frpc-'+cfgServer+'-bundle（演示）'); return; }
  if (act==='toggle'){ const p=proxiesCache.find(x=>x.id===id); closeAll(); runPipeline((p.enabled?'停用映射 ':'启用映射 ')+p.name,[p.name],()=>api('POST','/api/proxies/'+id+'/toggle')).then(res=>{toast(p.enabled?'映射已停用':'映射已启用','已生效 '+(res.reload?res.reload.ms:0)+'ms');loadAll().then(render);}); return; }
  if (act==='del'){ const p=proxiesCache.find(x=>x.id===id); closeAll(); runPipeline('删除映射 '+p.name,[p.name],()=>api('DELETE','/api/proxies/'+id)).then(res=>{toast('映射已删除','该隧道已从服务端注销');loadAll().then(render);}); return; }
  if (act==='start-server'){ const r=await api('POST','/api/servers/'+id+'/start'); await loadAll(); render(); if(r.data.ok===false){ toast('启动失败', esc(String(r.data.error||'frpc 未能启动')).slice(0,220), 'err'); } else { toast('实例已启动', r.data.simulated?'已拉起（config-only 模式）':'实例已就绪'); } return; }
  if (act==='stop-server'){ await api('POST','/api/servers/'+id+'/stop'); await loadAll(); render(); toast('实例已停止','该服务端下映射已全部离线','warn'); return; }
  if (act==='restart-server'){ const r=await api('POST','/api/servers/'+id+'/restart'); await loadAll(); render(); if(r.data.ok===false){ toast('重启失败', esc(String(r.data.error||'frpc 未能启动')).slice(0,220), 'err'); } else { toast('实例已重启','本次重启仅影响该服务端','warn'); } return; }
  if (act==='log-server'){ const r=await api('GET','/api/servers/'+id+'/log'); const s=serversCache.find(x=>x.id===id); $('#logTitle').textContent='frpc 运行日志 · '+(s?s.name:id); $('#logBody').textContent=r.data.log&&r.data.log.trim()?r.data.log:'（暂无日志：实例可能未启动过）'; openEl($('#logModal')); return; }
  if (act==='del-server'){ await api('DELETE','/api/servers/'+id); if(cfgServer===id)cfgServer=null; await loadAll(); render(); toast('服务端已删除','同时移除其下映射配置'); return; }
  if (act==='new-user') return openNewUser();
  if (act==='set-pwd') return openSetPwd(id);
  if (act==='del-user'){ const u=(window.__users||[]).find(x=>x.id===id); await api('DELETE','/api/users/'+id); toast('用户已删除', u?u.username:id); loadAll().then(render); return; }
});
function download(name, text){ const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([text],{type:'application/json'})); a.download=name; a.click(); URL.revokeObjectURL(a.href); }

/* 启动：先取品牌信息，再尝试恢复登录态（用裸 fetch，避免未登录时触发 401 重试/刷新） */
(async () => {
  await loadSettings();
  try {
    const r = await fetch('/api/me', { credentials: 'same-origin' });
    if (r.ok) { me = (await r.json()).user; return bootstrap(); }
  } catch (e) {}
  $('#loading').style.display = 'none';
  $('#loginWrap').classList.add('show');
})();
