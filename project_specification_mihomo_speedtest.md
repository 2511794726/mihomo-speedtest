# Project Specification: `mihomo-speedtest`

## 1. 项目概述与核心目标
构建一个基于 **Mihomo (Clash Meta) 内核** 的本地化代理订阅批量真实下载速率测速工具（CLI 终端交互 + JSON 结果持久化 + 自动同步最优节点）。
* **核心痛点解决**：
  1. 兼容多种订阅协议与返回格式（标准 Clash YAML、Base64 通用订阅、明文 URI 列表、`proxy-providers` 外部节点集及本地文件），解决机场 `User-Agent` 校验拦截问题。
  2. 规避客户端仅测延迟（Ping）的盲区，通过底层内核驱动真实流式下载测速，并防止分流规则走直连造成的“假满速”以及高倍率节点耗光套餐流量的问题。
* **技术栈要求**：
  * 运行环境：Node.js v18+（原生 ES Module 或 CommonJS 均可，推荐 ESM）。
  * 核心依赖：`js-yaml`（YAML 解析与生成）、`undici` 或 `https-proxy-agent`（隔离系统代理环境变量的显式代理请求）、`cli-table3`（终端可视化成绩单渲染）。
  * 零重型框架、零外部数据库依赖。

---

## 2. 目录结构规范
```text
mihomo-speedtest/
├── bin/
│   └── mihomo.exe             # 预先放置或由程序自动探测复制的 Mihomo Windows x64 内核
├── configs/
│   ├── sub.raw                # 原始拉取的订阅响应缓存（加入 .gitignore）
│   ├── raw-uris.txt           # 当订阅为 Base64/URI 格式时解码保存的纯文本节点集（加入 .gitignore）
│   └── runtime.yaml           # 动态清洗、注入全局规则与控制端口后的运行时配置（加入 .gitignore）
├── results/
│   └── speed-rank.json        # 测速结果持久化输出（按真实下载速率或性价比降序）
├── settings.json              # 用户配置文件（首次运行不存在时自动生成默认模板）
├── speedtest.js               # 核心测速主程序
├── package.json
├── SPEC.md                    # 本实施规范文档
└── .gitignore
```

---

## 3. 配置文件规范 (`settings.json`)
程序启动时读取 `settings.json`。若文件不存在，则自动创建以下默认模板并提示用户填入 `subscribeUrl` 后重新运行：
```json
{
  "subscribeUrl": "https://example.com/api/v1/client/subscribe?token=YOUR_TOKEN",
  "userAgents": [
    "ClashVerge/2.0.0",
    "ClashMetaForAndroid/2.11.2",
    "v2rayN/7.25.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
  ],
  "mixedPort": 17890,
  "controllerPort": 19090,
  "controllerSecret": "speedtest-secret",
  "testUrl": "https://speed.cloudflare.com/__down?bytes=25000000",
  "maxBytesPerNode": 10485760,
  "downloadTimeoutMs": 8000,
  "latencyTimeoutMs": 3000,
  "excludeKeywords": ["官网", "公告", "剩余流量", "套餐到期", "重置", "订阅", "网址"],
  "clashVergeApi": "http://127.0.0.1:9097",
  "clashVergeSecret": "",
  "autoApplyTopNode": false
}
```
*(设计说明：测试端口采用 `17890` 与 `19090`，严格避开用户日常运行的 Clash Verge 默认端口 `7890`/`9090`；单节点下载触发 `maxBytesPerNode` (10MB) 或 `downloadTimeoutMs` (8秒) 任一阈值即刻熔断，防止耗尽套餐流量。)*

---

## 4. 核心执行流程（AI 必须严格按此链路实现）

### 阶段一：环境预检与内核自动探测 (Pre-flight Check)
1. **端口冲突检测**：启动前检测 `settings.mixedPort` (`17890`) 和 `settings.controllerPort` (`19090`) 是否被占用，若被占用则自动递增端口号（`+1`）直到找到可用端口。
2. **内核自动定位**：检查 `bin/mihomo.exe` 是否存在。若不存在，自动扫描 Windows 常见安装路径：
   * `C:\Program Files\Clash Verge\verge-mihomo.exe`
   * `C:\Program Files\Clash Verge\mihomo.exe`
   * `${process.env.LOCALAPPDATA}\Programs\Clash Verge\verge-mihomo.exe`
   * `${process.env.LOCALAPPDATA}\Programs\Clash Verge\mihomo.exe`
   * 若找到则自动创建 `bin/` 目录并复制为 `bin/mihomo.exe`；若均未找到，输出清晰的中文提示指引用户手动复制后退出。

### 阶段二：多格式订阅获取与标准化管道（四层兼容架构）
1. **数据获取（支持在线 URL 与本地路径）**：
   * 若 `settings.subscribeUrl` 为本地文件路径（非 `http://` 或 `https://` 开头），直接读取本地文件内容作为 `rawText`。
   * 若为在线 URL，依次使用 `settings.userAgents` 列表中的请求头发起请求（禁用系统代理环境变量干扰），直到返回 HTTP 200 且响应体非空；将原始响应保存至 `configs/sub.raw`。
2. **四层格式自动嗅探与转换**：
   * **格式 A（标准 Clash YAML）**：`js-yaml.load(rawText)` 成功且 `Array.isArray(doc.proxies)` 包含有效出站节点。直接提取 `doc.proxies`。
   * **格式 B（Base64 订阅或明文 URI 列表）**：若 YAML 解析失败或结果为空，尝试对 `rawText.trim()` 进行 Base64 解码（兼容标准与 URL-Safe Base64）；若解码后或原文包含 `vless://`、`hy2://`、`hysteria2://`、`trojan://`、`ss://`、`vmess://`、`anytls://` 协议头，则将解码后的纯文本写入 `configs/raw-uris.txt`，并构造依赖 Mihomo 原生 `proxy-providers`（`type: file`, `path: ./raw-uris.txt`）的配置文件（借力内核原生解析，不手写复杂 URI 正则）。
   * **格式 C（远程 `proxy-providers` 配置）**：若 YAML 中 `proxies` 为空但存在 `proxy-providers` 对象，保留该对象并确保 `GLOBAL` 策略组通过 `use` 引用所有 provider。
3. **运行时配置强制清洗（防假速与 DNS 隔离核心）**：
   生成 `configs/runtime.yaml` 时，必须强制覆盖以下顶层配置，彻底杜绝走直连导致的“假满速”：
   * `mixed-port`: 动态探测后的本地混合端口（如 `17890`）
   * `external-controller`: `127.0.0.1:${controllerPort}`
   * `secret`: `settings.controllerSecret`
   * `mode`: `"global"`（强制全局代理模式）
   * `rules`: `["MATCH,GLOBAL"]`（**关键：强制清空原订阅的所有分流规则，确保 100% 流量必须经过当前切换的节点**）
   * `dns`: 注入干净的 `enhanced-mode: fake-ip` 与 `nameserver: ["223.5.5.5", "1.1.1.1"]`，防止本地 DNS 污染导致节点误判死亡。

### 阶段三：拉起 Mihomo 内核与节点白名单过滤
1. 使用 `child_process.spawn` 静默启动子进程：`./bin/mihomo.exe -d ./configs -f ./configs/runtime.yaml`。
2. 注册进程退出钩子（`SIGINT`、`SIGTERM`、`exit`、`uncaughtException`），确保主进程无论因何种原因退出，必定同步 `kill()` 掉 `mihomo.exe` 子进程，绝不残留僵尸进程。
3. 轮询 `GET http://127.0.0.1:${controllerPort}/version`（携带 `Authorization: Bearer ${controllerSecret}`），等待返回 HTTP 200（若配置含 `proxy-providers`，额外等待 `/providers/proxies` 加载完毕）。
4. **节点过滤白名单**：
   * 调用 `GET http://127.0.0.1:${controllerPort}/proxies` 获取所有代理信息。
   * 仅保留真实出站协议类型（白名单：`ss`, `ssr`, `vmess`, `vless`, `trojan`, `hysteria`, `hysteria2`, `tuic`, `anytls`, `wireguard`, `socks5`, `http`），剔除 `Selector`、`URLTest`、`Fallback`、`LoadBalance`、`Direct`、`Reject` 等虚拟策略组。
   * 剔除节点名称包含 `settings.excludeKeywords` 关键词的信息节点。
   * 自动使用正则（如 `/(\d+(?:\.\d+)?)\s*[xX倍]/`）提取每个节点名称中的流量倍率（未标注默认计为 `1.0`）。

### 阶段四：串行双阶段测速循环（严格单线程防带宽争抢）
遍历过滤后的每一个有效节点：
1. **切换全局出口**：
   * `PUT http://127.0.0.1:${controllerPort}/proxies/GLOBAL`，Body 为 `{"name": nodeName}`。
2. **第一关：真连接延迟预筛**：
   * `GET http://127.0.0.1:${controllerPort}/proxies/${encodeURIComponent(nodeName)}/delay?timeout=${latencyTimeoutMs}&url=http://www.gstatic.com/generate_204`
   * 若超时或报错，直接标记为 `Dead / Timeout` 并跳过下载阶段，进入下一节点。
3. **第二关：流式真实下载速率测试（含稳态速度与流量熔断）**：
   * 使用显式指定的本地代理客户端（`ProxyAgent("http://127.0.0.1:${mixedPort}")`），**禁止读取系统环境变量 `HTTP_PROXY`/`HTTPS_PROXY`**，避免与本机运行的其他代理软件形成“套娃代理”。
   * 发起流式请求至 `settings.testUrl`，同时启动 `AbortController` 定时器（`settings.downloadTimeoutMs`）。
   * 逐块接收数据流（Stream），记录：
     * `totalBytes`：累计接收字节数。
     * `steadyBytes` 与 `steadyStartTime`：跳过前 `1500ms`（TCP/TLS 慢启动阶段）后累计的字节数与起始时间，用于评估看 4K 视频时的真实稳态带宽。
   * **熔断触发**：当 `totalBytes >= settings.maxBytesPerNode` 或达到 `downloadTimeoutMs` 超时时，立即调用 `controller.abort()` 切断连接并结算。
   * **速率计算**：
     * 全程平均速率 `avgSpeedMBps = (totalBytes / 1024 / 1024) / elapsedSeconds`
     * 稳态下载速率 `steadySpeedMBps`（若总耗时不足 2 秒则等同于 `avgSpeedMBps`）
     * 性价比指数 `valueScore = avgSpeedMBps / multiplier`（下载速度 ÷ 流量倍率）
4. **终端动态进度输出**：
   实时打印进度，例如：
   `[14/96] 香港01 | IPLC | 1x (AnyTLS) -> 延迟: 46ms | 均速: 18.42 MB/s | 稳态: 21.10 MB/s`

### 阶段五：结果持久化、可视化榜单与 Clash Verge 联动
1. **排序与保存**：按 `avgSpeedMBps` 降序排列所有节点，将完整结构化数据写入 `results/speed-rank.json`。
2. **终端表格输出**：使用 `cli-table3` 渲染排名前 20 名的可视化表格，包含列：`排名`、`节点名称`、`协议`、`倍率`、`延迟(ms)`、`平均下载(MB/s)`、`稳态下载(MB/s)`、`性价比得分`。
3. **“测完即用”闭环联动（可选）**：
   * 测速结束后，探测 `settings.clashVergeApi`（如 `http://127.0.0.1:9097/proxies`）是否在线。
   * 若检测到本机 Clash Verge 正在运行且 `autoApplyTopNode` 为 `true`（或在终端通过内置 `readline` 询问用户 `y/N`），自动调用 Clash Verge 控制接口将 Top 1 最快节点应用到用户的日常策略组中。
4. **安全清理**：关闭 `mihomo.exe` 子进程并退出程序。

---

## 5. 异常处理与安全隔离要求
* **单节点容错**：单个节点在下载途中发生 `ECONNRESET`、TLS 握手异常或 `AbortError`（正常超时截断）时，必须安全捕获，不得导致主程序崩溃；若是超时截断且已下载超过 `512KB` 数据，仍需按实际下载字节与耗时计算有效均速。
* **隐私防泄露**：生成的 `.gitignore` 必须强制包含：
  ```gitignore
  node_modules/
  bin/
  configs/
  results/
  settings.json
  ```
```

你可以将这份 `SPEC.md` 保存到项目根目录，直接交由 AI 编码助手一键生成完整工程代码并安装依赖。