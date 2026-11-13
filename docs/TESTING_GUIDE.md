# `mihomo-speedtest` 测试流程文档

本文档定义了 `mihomo-speedtest` 的分层测试策略、核心测试用例矩阵以及本地自动化与端到端（E2E）验收流程。

---

## 1. 测试分层策略

| 测试层级 | 工具与方式 | 目标与覆盖范围 |
| :--- | :--- | :--- |
| **单元测试 (Unit)** | `node:test` + `node:assert/strict` | 验证纯逻辑函数：Base64/URI 嗅探、YAML 清洗、节点白名单过滤、倍率提取、速率与稳态速度计算。 |
| **集成测试 (Integration)** | `node:test` + `node:http` 本地 Mock 服务 | 模拟订阅服务器（多 UA 校验）、Mock Mihomo Controller API、Mock 流式下载服务器（限速/熔断/断流），验证完整测速与报告闭环。 |
| **端到端测试 (E2E)** | 真实 `bin/mihomo.exe` + 本地测试配置 | 验证真实 Mihomo 内核拉起、Controller 就绪轮询、端口冲突自增、退出时子进程无残留。 |

---

## 2. 测试用例矩阵

### 2.1 环境预检 (`test/preflight.test.js`)
- **TC-PRE-01 端口冲突自增**：预先占用一个本地端口，调用 `findAvailablePort` 应自动返回 `port + 1` 的可用端口。
- **TC-PRE-02 内核路径探测**：给定存在的候选路径时能够正确识别并复制到目标 `bin/mihomo.exe`；全部不存在时返回明确状态。

### 2.2 订阅获取与四层格式清洗 (`test/subscribe.test.js`)
- **TC-SUB-01 多 UA 轮询**：Mock 订阅服务器拒绝前两个 UA（返回 403），仅对第 3 个 UA 返回 200，验证程序能自动切换 UA 成功获取并保存 `sub.raw`。
- **TC-SUB-02 格式 A（标准 Clash YAML）**：输入含 `proxies` 与原有分流 `rules`、`mode: rule` 的 YAML，验证输出 `runtime.yaml` 强制覆盖为 `mode: global`、`rules: ["MATCH,GLOBAL"]` 且注入 `fake-ip` DNS。
- **TC-SUB-03 格式 B1（标准 Base64 订阅）**：输入 Base64 编码的 `vless://` + `hy2://` 列表，验证解码写入 `raw-uris.txt` 并生成 `proxy-providers` + `GLOBAL` 引用配置。
- **TC-SUB-04 格式 B2（URL-Safe Base64 & 明文 URI）**：输入包含 `-`/`_` 的 URL-Safe Base64 及直接明文 URI 列表，验证均能正确识别转换。
- **TC-SUB-05 格式 C（远程 `proxy-providers`）**：输入 `proxies` 为空但含 `proxy-providers` 的 YAML，验证保留 provider 且 `GLOBAL` 组通过 `use` 引用所有 provider。

### 2.3 节点过滤与倍率解析 (`test/mihomo.test.js`)
- **TC-FLT-01 协议白名单**：混入 `Selector`、`URLTest`、`Direct`、`Reject` 与真实协议（`vless`, `hysteria2`, `anytls`, `ss` 等），验证仅保留真实出站节点。
- **TC-FLT-02 关键词过滤**：节点名包含 `剩余流量`、`官网`、`套餐到期` 等关键词时应被剔除。
- **TC-FLT-03 倍率提取**：
  - `"香港01 | 2x"` -> `2.0`
  - `"日本 [0.5X]"` -> `0.5`
  - `"新加坡 1.5倍"` -> `1.5`
  - `"美国直连"` -> `1.0`

### 2.4 测速引擎与容错 (`test/tester.test.js`)
- **TC-TST-01 延迟预筛失败跳过**：Mock Controller `/delay` 返回超时或 504，验证跳过下载阶段并标记为超时/不可用。
- **TC-TST-02 正常流式下载与稳态速率**：Mock 代理转发本地流式下载服务器（持续 2.5s），验证 `avgSpeedMBps`、`steadySpeedMBps` 与 `valueScore` 计算准确。
- **TC-TST-03 流量上限熔断**：设置 `maxBytesPerNode = 1048576` (1MB)，Mock 服务器持续吐出 5MB 数据，验证下载在达到 1MB 左右立即触发 `AbortController` 熔断停止。
- **TC-TST-04 超时截断 >512KB 保留有效成绩**：设置 `downloadTimeoutMs = 800`，Mock 服务器慢速输出 >600KB 后触发超时，验证捕获 `AbortError` 并保留有效均速。
- **TC-TST-05 异常中断 <512KB 判无效**：Mock 服务器输出 100KB 后强制断开（`ECONNRESET`），验证不崩溃且该节点速度记为无效（`0` / `Failed`）。
- **TC-TST-06 环境变量隔离**：在进程中设置无效的 `process.env.HTTP_PROXY = "http://127.0.0.1:59999"`，验证测速请求仍走显式 `mixedPort` 而不受环境变量影响。

### 2.5 报告输出与 Clash Verge 联动 (`test/report.test.js`)
- **TC-RPT-01 排序与 JSON 持久化**：验证按 `avg`、`steady`、`value` 三种模式排序结果正确，且写入 `results/speed-rank.json` 结构完整。
- **TC-RPT-02 Clash Verge Selector 自动探测**：Mock Clash Verge API `/proxies`，验证在未配置 `clashVergeSelector` 时能自动找到包含 Top 1 节点的 `Selector` 组（忽略 `GLOBAL`）并发送 `PUT` 切换请求。

---

## 3. 执行与验收流程

### 第一步：运行自动化测试套件
在项目根目录执行：
```bash
npm test
```
预期结果：所有单元测试与集成测试全部通过（`pass`），无失败（`fail: 0`）或未捕获异常。

### 第二步：真实内核冒烟测试（可选/本机有 Mihomo 时）
1. 确认 `bin/mihomo.exe` 存在（或本机已安装 Clash Verge 由程序自动复制）。
2. 使用本地测试配置运行 `node speedtest.js` 或内核拉起检查，确认：
   - 控制台正常打印版本与节点列表。
   - 按 `Ctrl+C` 或正常结束后，任务管理器/`Get-Process mihomo` 中无残留 `mihomo.exe` 进程。
