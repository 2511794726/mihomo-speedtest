# `mihomo-speedtest` 实施步骤流程文档

本文档基于 [project_specification_mihomo_speedtest.md](../project_specification_mihomo_speedtest.md) 及需求对齐结果制定，用于指导项目的模块化开发与分阶段落地。

---

## 1. 技术栈与工程结构

- **运行环境**：Node.js v18+（当前环境 v22.17.0），原生 ESM（`"type": "module"`）。
- **核心依赖**：
  - `js-yaml`：YAML 订阅解析与 `runtime.yaml` 生成。
  - `undici`：显式 `ProxyAgent` 与独立 `Agent`，严格隔离系统 `HTTP_PROXY`/`HTTPS_PROXY` 环境变量。
  - `cli-table3`：终端可视化 Top 20 成绩单渲染。
- **测试框架**：Node.js 原生 `node:test` 与 `node:assert/strict`（零额外测试框架依赖）。

### 目录结构
```text
mihomo-speedtest/
├── bin/
│   └── mihomo.exe             # Mihomo Windows x64 内核（自动探测复制或手动放置）
├── configs/                   # 运行时缓存与生成配置（.gitignore 忽略）
│   ├── sub.raw
│   ├── raw-uris.txt
│   └── runtime.yaml
├── docs/
│   ├── IMPLEMENTATION_PLAN.md # 本实施步骤文档
│   └── TESTING_GUIDE.md       # 测试流程文档
├── results/                   # 测速结果输出（.gitignore 忽略）
│   └── speed-rank.json
├── src/
│   ├── config.js              # 配置加载、默认模板生成与 CLI 参数解析
│   ├── preflight.js           # 端口冲突探测与 Mihomo 内核自动定位复制
│   ├── subscribe.js           # 多 UA 订阅拉取、四层格式嗅探与 runtime.yaml 清洗
│   ├── mihomo.js              # Mihomo 子进程生命周期管理、API 就绪轮询与节点过滤
│   ├── tester.js              # 串行双阶段测速引擎（延迟预筛 + 流式稳态下载 + 熔断）
│   └── report.js              # 排序、JSON 持久化、表格渲染与 Clash Verge 联动
├── test/                      # 自动化单元测试与集成测试
├── settings.json              # 用户配置（.gitignore 忽略）
├── speedtest.js               # 主程序入口（编排 5 阶段流水线）
├── package.json
└── .gitignore
```

---

## 2. 分阶段实施步骤

### 步骤一：工程初始化与安全隔离
1. 初始化 `package.json`，设置 `"type": "module"`，添加 `start`、`test` 脚本。
2. 安装核心依赖：`js-yaml`、`undici`、`cli-table3`。
3. 创建 `.gitignore`，强制忽略 `node_modules/`、`bin/`、`configs/`、`results/`、`settings.json`。

### 步骤二：配置管理与 CLI 参数解析 (`src/config.js`)
1. 定义 `DEFAULT_SETTINGS` 模板（包含 `mixedPort: 17890`、`controllerPort: 19090`、`clashVergeSelector: ""` 等）。
2. 启动时检查 `settings.json`：若不存在则自动写入默认模板并提示用户填入 `subscribeUrl` 后退出。
3. 合并用户配置与默认值，解析 CLI 参数（支持 `--sort=avg|steady|value`，默认 `avg`）。

### 步骤三：环境预检与内核探测 (`src/preflight.js`)
1. **端口冲突探测**：使用 `node:net` 尝试绑定 `127.0.0.1:${port}`，若端口被占用则循环 `+1` 直到找到可用端口，分别确定 `mixedPort` 与 `controllerPort`（确保两者不冲突）。
2. **内核定位**：检查 `bin/mihomo.exe` 是否存在；若不存在，按顺序扫描 Clash Verge 常见安装路径，找到后创建 `bin/` 并复制；若均未找到，输出中文指引并退出。

### 步骤四：多格式订阅获取与配置清洗 (`src/subscribe.js`)
1. **订阅获取**：
   - 本地路径（非 `http://`/`https://` 开头）：直接读取文件内容。
   - 在线 URL：使用无代理的独立 `undici.Agent`（忽略环境变量代理），依次轮询 `settings.userAgents` 发起请求，直到 HTTP 200 且响应非空；写入 `configs/sub.raw`。
2. **四层格式嗅探**：
   - **格式 A（标准 Clash YAML）**：`js-yaml.load` 成功且 `proxies` 为非空数组。
   - **格式 B（Base64 / 明文 URI 列表）**：尝试标准与 URL-Safe Base64 解码，检测是否包含 `vless://`、`hy2://`、`hysteria2://`、`trojan://`、`ss://`、`vmess://`、`anytls://`；写入 `configs/raw-uris.txt`，生成基于 `proxy-providers`（`type: file`, `path: ./raw-uris.txt`）的配置并挂载到 `GLOBAL` 策略组。
   - **格式 C（远程 `proxy-providers`）**：YAML 中 `proxies` 为空但存在 `proxy-providers`，保留并确保 `GLOBAL` 策略组通过 `use` 引用所有 provider。
3. **运行时强制清洗 (`configs/runtime.yaml`)**：
   - 强制覆盖 `mixed-port`、`external-controller`、`secret`。
   - 强制设置 `mode: "global"` 与 `rules: ["MATCH,GLOBAL"]`（彻底杜绝分流直连假满速）。
   - 注入干净的 `dns` 配置（`enhanced-mode: fake-ip`，`nameserver: ["223.5.5.5", "1.1.1.1"]`）。

### 步骤五：Mihomo 内核管理与节点过滤 (`src/mihomo.js`)
1. 使用 `child_process.spawn` 启动 `bin/mihomo.exe -d ./configs -f ./configs/runtime.yaml`。
2. 注册进程退出钩子（`SIGINT`、`SIGTERM`、`exit`、`uncaughtException`），保证主进程任何路径退出均同步 `kill()` 子进程，绝不残留僵尸进程。
3. 轮询 `GET /version`（携带 `Authorization: Bearer ${secret}`）直至 200；若配置含 `proxy-providers`，额外轮询 `/providers/proxies` 等待节点加载完毕。
4. 调用 `GET /proxies` 获取所有代理：
   - 协议白名单过滤：`ss`, `ssr`, `vmess`, `vless`, `trojan`, `hysteria`, `hysteria2`, `tuic`, `anytls`, `wireguard`, `socks5`, `http`。
   - 关键词黑名单剔除（`settings.excludeKeywords`）。
   - 正则 `/(\d+(?:\.\d+)?)\s*[xX倍]/` 提取流量倍率（默认 `1.0`）。

### 步骤六：串行双阶段测速引擎 (`src/tester.js`)
遍历每个有效节点（严格串行）：
1. **切换出口**：`PUT /proxies/GLOBAL` `{"name": nodeName}`。
2. **第一关（延迟预筛）**：`GET /proxies/${encodeURIComponent(nodeName)}/delay?timeout=${latencyTimeoutMs}&url=http://www.gstatic.com/generate_204`，失败或超时直接记为 `Dead / Timeout` 并跳过下载。
3. **第二关（流式真实下载与熔断）**：
   - 使用 `undici.ProxyAgent("http://127.0.0.1:${mixedPort}")` 作为 `dispatcher` 发起流式请求（完全隔离系统代理环境变量）。
   - 配合 `AbortController` 定时器（`downloadTimeoutMs`）。
   - 逐块读取流：记录 `totalBytes`，并在经过 `1500ms` 慢启动期后记录 `steadyBytes` 与 `steadyStartTime`。
   - 当 `totalBytes >= maxBytesPerNode` 或超时，立即 `abort()` 结算。
   - 异常容错：捕获 `ECONNRESET`、TLS 异常、`AbortError`；若发生截断/异常但已下载超过 `512KB`，仍按实际字节与耗时计算有效均速。
   - 计算 `avgSpeedMBps`、`steadySpeedMBps`（总耗时 `< 2s` 时等同于 `avgSpeedMBps`）、`valueScore = avgSpeedMBps / multiplier`。
4. 实时打印单节点测速进度。

### 步骤七：结果输出与 Clash Verge 联动 (`src/report.js` & `speedtest.js`)
1. 按指定排序字段（默认 `avgSpeedMBps`，支持 `steadySpeedMBps` / `valueScore`）降序排列。
2. 写入 `results/speed-rank.json`。
3. 使用 `cli-table3` 渲染 Top 20 榜单。
4. 探测 `settings.clashVergeApi` 是否在线：
   - 若在线且有可用最快节点，根据 `autoApplyTopNode` 或 `readline` 交互确认（`y/N`）。
   - 目标策略组定位：优先使用 `settings.clashVergeSelector`；若未配置，自动从 `/proxies` 中查找包含该 Top 1 节点的 `Selector` 策略组（排除 `GLOBAL`）。
   - 调用 `PUT /proxies/${encodeURIComponent(groupName)}` 应用节点。
5. 安全关闭 `mihomo.exe` 子进程并退出。
