/**
 * 基于测速结果，按不同使用场景智能推荐最优节点。
 * 仅从 status === 'OK' 且延迟有效的真实可用节点中挑选。
 * @param {Array<Record<string, any>>} results
 */
export function buildSceneRecommendations(results) {
  const valid = (results || []).filter(
    (r) => r && r.status === 'OK' && typeof r.latencyMs === 'number' && r.avgSpeedMBps > 0,
  );

  const pickBest = (scorer, reverse = false) => {
    if (valid.length === 0) return null;
    const sorted = [...valid].sort((a, b) => {
      const diff = scorer(b) - scorer(a);
      return reverse ? -diff : diff;
    });
    return sorted[0];
  };

  // 1. 4K / 高清流媒体：稳态带宽主导
  const videoNode = pickBest(
    (n) => (n.steadySpeedMBps || 0) * 0.75 + (n.avgSpeedMBps || 0) * 0.25,
  );

  // 2. 大文件 / 代码镜像下载：全程均速主导
  const downloadNode = pickBest(
    (n) => (n.avgSpeedMBps || 0) * 0.8 + (n.steadySpeedMBps || 0) * 0.2,
  );

  // 3. 游戏 / 实时交互：低延迟主导（且已过滤掉假低延迟失败节点）
  const gamingNode = valid.length
    ? [...valid].sort((a, b) => {
        if (a.latencyMs !== b.latencyMs) return a.latencyMs - b.latencyMs;
        return (b.avgSpeedMBps || 0) - (a.avgSpeedMBps || 0);
      })[0]
    : null;

  // 4. 日常省流 / 高性价比：性价比得分主导
  const valueNode = pickBest((n) => n.valueScore || 0);

  return [
    {
      id: 'video',
      title: '4K 视频 / 流媒体',
      icon: 'mdi:television-play',
      accentClass: 'text-[#0A84FF]',
      node: videoNode,
      metricText: videoNode ? `稳态 ${videoNode.steadySpeedMBps.toFixed(2)} MB/s` : '--',
      subText: videoNode ? `延迟 ${videoNode.latencyMs} ms · ${videoNode.multiplier}x` : '暂无可用节点',
      badge:
        videoNode && videoNode.steadySpeedMBps >= 6
          ? { text: '流畅 4K/8K', variant: 'success' }
          : videoNode && videoNode.steadySpeedMBps >= 2.5
            ? { text: '稳定 1080P/2K', variant: 'info' }
            : videoNode
              ? { text: '适合 720P', variant: 'warning' }
              : null,
    },
    {
      id: 'download',
      title: '大文件 / 镜像下载',
      icon: 'mdi:cloud-download-outline',
      accentClass: 'text-[#30D158]',
      node: downloadNode,
      metricText: downloadNode ? `均速 ${downloadNode.avgSpeedMBps.toFixed(2)} MB/s` : '--',
      subText: downloadNode
        ? `稳态 ${downloadNode.steadySpeedMBps.toFixed(2)} MB/s · ${downloadNode.multiplier}x`
        : '暂无可用节点',
      badge:
        downloadNode && downloadNode.avgSpeedMBps >= 5
          ? { text: '高速下载', variant: 'success' }
          : downloadNode && downloadNode.avgSpeedMBps >= 1.5
            ? { text: '常规可用', variant: 'info' }
            : downloadNode
              ? { text: '速率偏慢', variant: 'warning' }
              : null,
    },
    {
      id: 'gaming',
      title: '游戏 / 低延迟交互',
      icon: 'mdi:gamepad-variant-outline',
      accentClass: 'text-[#FF9F0A]',
      node: gamingNode,
      metricText: gamingNode ? `延迟 ${gamingNode.latencyMs} ms` : '--',
      subText: gamingNode
        ? `均速 ${gamingNode.avgSpeedMBps.toFixed(2)} MB/s · ${gamingNode.multiplier}x`
        : '暂无可用节点',
      badge:
        gamingNode && gamingNode.latencyMs <= 80
          ? { text: '极低延迟', variant: 'success' }
          : gamingNode && gamingNode.latencyMs <= 180
            ? { text: '延迟良好', variant: 'info' }
            : gamingNode
              ? { text: '延迟较高', variant: 'warning' }
              : null,
    },
    {
      id: 'value',
      title: '日常省流 / 高性价比',
      icon: 'mdi:piggy-bank-outline',
      accentClass: 'text-[#64D2FF]',
      node: valueNode,
      metricText: valueNode ? `性价比 ${valueNode.valueScore.toFixed(2)}` : '--',
      subText: valueNode
        ? `${valueNode.multiplier}x 倍率 · 均速 ${valueNode.avgSpeedMBps.toFixed(2)} MB/s`
        : '暂无可用节点',
      badge: valueNode ? { text: `${valueNode.multiplier}x 优选`, variant: 'info' } : null,
    },
  ];
}
