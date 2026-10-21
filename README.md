# FRP 客户端管理平台

基于 [fatedier/frp](https://github.com/fatedier/frp) 的 **Web 管理平台**：在浏览器中维护多个 frpc 服务端连接与映射，
保存后通过 frpc 的 Admin API（ `GET /api/reload` ）**即时热加载生效，无需重启客户端进程**。

完整设计方案见 [`docs/frp-client-platform-design.md`](docs/frp-client-platform-design.md)；纯前端交互原型见 [`demo/index.html`](demo/index.html)。

## 架构

```
浏览器 SPA (server/web)
      │  REST API + HttpOnly Session
      ▼
管理后端 (server/src, Node.js)
      ├─ SQLite（唯一事实源：servers / proxies / users / audit）
      ├─ config.js  渲染 frpc.toml + proxies/*.toml（原子写盘）
      └─ frpc.js    进程管理 + Admin API 热加载
                        │
                        ▼
                 frpc 实例（每个服务端一个进程）
```

> 实现说明：设计文档以 Go + gin 为例，本仓库提供**可直接运行的 MVP 后端（Node.js，零外部依赖，使用内置 `node:sqlite`）**，
> 在本机无 Go 工具链时也能完整跑起来并验证 API / 鉴权 / 热加载模型。API 契约、鉴权边界、配置渲染逻辑与文档一致，
> 生产环境可等价为 Go 实现。

## 快速开始

### 方式一：Docker（推荐）

```bash
docker compose up -d --build
# 打开 http://localhost:8080
```

如需真实热加载，把宿主机 `frpc` 二进制挂进容器（见 `docker-compose.yml` 注释），并设置 `FRPC_BIN`。

### 方式二：本地 Node

```bash
cd server
node src/server.js        # 需 Node >= 22.5
# 打开 http://localhost:8080
```

### 演示账号

| 账号 | 密码 | 权限 |
|---|---|---|
| `admin` | `admin123` | 管理员：维护服务端连接信息、启停实例、维护映射、管理用户 |
| `user` | `user123` | 普通用户：仅维护映射（新增 / 编辑 / 删除 / 启停），服务端只读 |

> 初始管理员由 `MANAGER_USER` / `MANAGER_PASSWORD` 环境变量指定；未设置时默认 `admin/admin123`。

## 功能

- **多服务端**：每个服务端对应一个独立 frpc 进程，记录地址 / 端口 / Token / 传输协议 / TLS / 绑定域名 / vhost 端口。
- **映射管理**：TCP/UDP/HTTP/HTTPS/STCP/SUDP/XTCP/TCPMUX；按服务端、类型、状态筛选搜索。
- **热加载生效**：映射变更 → 校验 → 原子写盘 → `frpc reload` → 状态确认，全程不重启进程。
- **域名绑定**：服务端配置 `domain`（如 `bj.example.com`）后，HTTP(S) 映射自动带出域名，用户只填子域名前缀，列表展示 `前缀.域名:vhost端口`。
- **导入 / 导出**：映射 JSON 导入导出（跨环境迁移）。
- **角色鉴权**：管理员 / 普通用户两级，服务端维度接口强制 admin；非 admin 的 `GET /api/servers` 脱敏（隐藏 Token）。
- **审计日志**：所有变更留痕，普通用户仅见本人操作。

## 目录

```
server/
  src/db.js         SQLite 初始化、种子数据、密码哈希
  src/config.js     TOML 渲染 + 落盘（common + 分片）
  src/frpc.js       frpc 进程管理 + Admin API 热加载
  src/server.js     HTTP 服务、鉴权、REST API、静态托管
  web/              前端 SPA（index.html / app.js / styles.css）
demo/index.html     纯前端交互原型（内存 mock，无需后端）
docs/               设计文档
```

## 配置项（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8080` | 管理后端监听端口 |
| `DATA_DIR` | `./data` | SQLite 与渲染配置存放目录 |
| `FRPC_BIN` | `frpc` | frpc 二进制路径；找不到则进入 config-only 模式 |
| `MANAGER_USER` / `MANAGER_PASSWORD` | `admin` / `admin123` | 初始管理员账号 |
