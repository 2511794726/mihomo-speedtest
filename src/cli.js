import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSettings, parseCliArgs } from './config.js';
import { resolvePorts, ensureMihomoBinary } from './preflight.js';
import { prepareRuntimeSubscription } from './subscribe.js';
import { startMihomoProcess, fetchFilteredProxies } from './mihomo.js';
import { runSerialSpeedTests } from './tester.js';
import {
  sortResults,
  saveSpeedRank,
  renderTopTable,
  applyTopNodeToClashVerge,
} from './report.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

async function main() {
  const { sortBy } = parseCliArgs();
  const limitArg = process.argv.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? Number.parseInt(limitArg.slice('--limit='.length), 10) : 0;

  const settingsPath = path.join(rootDir, 'settings.json');
  const configsDir = path.join(rootDir, 'configs');
  const binaryPath = path.join(rootDir, 'bin', 'mihomo.exe');
  const outputPath = path.join(rootDir, 'results', 'speed-rank.json');

  // 1. 加载配置
  const { created, settings } = await loadSettings(settingsPath);
  if (created) {
    console.log(`已生成默认配置文件: ${settingsPath}`);
    console.log('请填入有效的 subscribeUrl 后重新运行。');
    return;
  }

  console.log('=== Mihomo Speedtest 启动 ===');

  // 2. 阶段一：端口预检与内核定位
  const { mixedPort, controllerPort } = await resolvePorts(settings);
  const binInfo = await ensureMihomoBinary(binaryPath);
  console.log(`使用内核 -> ${binInfo.path}`);
  console.log(`分配端口 -> mixedPort: ${mixedPort}, controllerPort: ${controllerPort}`);

  // 3. 阶段二：订阅获取与运行时配置清洗
  const subInfo = await prepareRuntimeSubscription(settings, {
    mixedPort,
    controllerPort,
    configsDir,
  });
  console.log(
    `订阅解析完成 -> 来源: ${subInfo.source}, 格式: ${subInfo.format}` +
      (subInfo.usedUserAgent ? `, UA: ${subInfo.usedUserAgent}` : ''),
  );

  // 4. 阶段三：拉起 Mihomo 内核与节点白名单过滤
  const mihomo = await startMihomoProcess({
    binaryPath: binInfo.path,
    configsDir,
    runtimeYamlPath: subInfo.runtimeYamlPath,
    controllerPort,
    controllerSecret: settings.controllerSecret,
    hasProviders: subInfo.hasProviders,
  });

  try {
    const controllerCtx = {
      controllerPort,
      controllerSecret: settings.controllerSecret,
      dispatcher: mihomo.dispatcher,
    };

    let nodes = await fetchFilteredProxies(controllerCtx, settings.excludeKeywords, {
      includeRegions: settings.includeRegions,
      includeKeywords: settings.includeKeywords,
      regionKeywords: settings.regionKeywords,
    });
    if (nodes.length === 0) {
      console.log('未发现任何符合条件的有效出站节点，测速结束。');
      return;
    }
    if (limit > 0 && nodes.length > limit) {
      console.log(`共发现 ${nodes.length} 个有效节点，按 --limit=${limit} 抽取前 ${limit} 个进行测速...\n`);
      nodes = nodes.slice(0, limit);
    } else {
      console.log(`共发现 ${nodes.length} 个有效节点，开始串行双阶段测速...\n`);
    }

    // 5. 阶段四：串行双阶段测速
    const rawResults = await runSerialSpeedTests(nodes, {
      ...controllerCtx,
      mixedPort,
      settings,
      onProgress: ({ index, total, result }) => {
        const prefix = `[${index}/${total}] ${result.name} (${result.type} | ${result.multiplier}x)`;
        if (result.latencyMs === null) {
          console.log(`${prefix} -> ${result.status}`);
        } else if (result.status !== 'OK') {
          console.log(`${prefix} -> 延迟: ${result.latencyMs}ms | 下载失败 (${result.error || result.status})`);
        } else {
          console.log(
            `${prefix} -> 延迟: ${result.latencyMs}ms | 均速: ${result.avgSpeedMBps.toFixed(2)} MB/s | 稳态: ${result.steadySpeedMBps.toFixed(2)} MB/s`,
          );
        }
      },
    });

    // 6. 阶段五：排序、持久化、表格渲染与 Clash Verge 联动
    const sorted = sortResults(rawResults, sortBy);
    await saveSpeedRank(sorted, outputPath, sortBy);

    console.log(`\n测速完成 (排序依据: ${sortBy})，完整结果已保存至: ${outputPath}\n`);
    console.log(renderTopTable(sorted, 20));

    const bestNode = sorted.find((r) => r.status === 'OK' && r.avgSpeedMBps > 0);
    if (bestNode) {
      const applyRes = await applyTopNodeToClashVerge(bestNode.name, settings);
      if (applyRes.applied) {
        console.log(`\n已将最快节点 "${bestNode.name}" 自动应用到 Clash Verge 策略组 "${applyRes.selector}"。`);
      } else if (applyRes.reason && !applyRes.reason.includes('未在线')) {
        console.log(`\nClash Verge 联动跳过: ${applyRes.reason}`);
      }
    }
  } finally {
    await mihomo.stop();
  }
}

main().catch((err) => {
  console.error(`\n程序运行出错: ${err.message}`);
  process.exitCode = 1;
});
