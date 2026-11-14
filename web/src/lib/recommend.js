/**
 * 基于测速结果，按不同使用场景与主流平台智能推荐最优节点。
 * 仅从 status === 'OK' 且延迟有效的真实可用节点中挑选。
 * @param {Array<Record<string, any>>} results
 */
export function buildSceneRecommendations(results) {
  const valid = (results || []).filter(
    (r) => r && r.status === 'OK' && typeof r.latencyMs === 'number' && r.avgSpeedMBps > 0,
  );

  const pickBest = (scorer, pool = valid) => {
    if (!pool || pool.length === 0) return null;
    const sorted = [...pool].sort((a, b) => scorer(b) - scorer(a));
    return sorted[0];
  };

  const getJitter = (n) => (typeof n.jitterMs === 'number' && n.jitterMs >= 0 ? n.jitterMs : 20);
  const getLoss = (n) => (typeof n.packetLoss === 'number' && n.packetLoss >= 0 ? n.packetLoss : 0);
  const isZeroLoss = valid.filter((n) => getLoss(n) === 0);
  const stablePool = isZeroLoss.length > 0 ? isZeroLoss : valid;

  // 1. 4K / 高清流媒体 (YouTube / Netflix)
  const videoNode = pickBest((n) => {
    let score = (n.steadySpeedMBps || 0) * 0.75 + (n.avgSpeedMBps || 0) * 0.25;
    if (n.unlock?.netflix === 'full') score += 1.5;
    else if (n.unlock?.netflix === 'originals') score += 0.5;
    return score;
  });

  // 2. 大文件 / GitHub 镜像下载
  const downloadNode = pickBest(
    (n) => (n.avgSpeedMBps || 0) * 0.8 + (n.steadySpeedMBps || 0) * 0.2,
  );

  // 3. 游戏 / 低延迟实时交互
  const gamingNode = valid.length
    ? [...valid].sort((a, b) => {
        if (a.latencyMs !== b.latencyMs) return a.latencyMs - b.latencyMs;
        if (getJitter(a) !== getJitter(b)) return getJitter(a) - getJitter(b);
        return (b.avgSpeedMBps || 0) - (a.avgSpeedMBps || 0);
      })[0]
    : null;

  // 4. WhatsApp / Telegram 聊天与语音通话：低丢包、低抖动、低延迟、稳定在线
  const chatNode = pickBest((n) => {
    const latPenalty = Math.min(n.latencyMs, 400) * 0.45;
    const jitterPenalty = Math.min(getJitter(n), 120) * 1.2;
    const lossPenalty = getLoss(n) * 4;
    const speedBonus = Math.min(n.steadySpeedMBps || 0, 8) * 3;
    return 300 - latPenalty - jitterPenalty - lossPenalty + speedBonus;
  }, stablePool);

  // 5. ChatGPT / Claude 等 AI 办公：优先 GPT 解锁 + 原生家宽 + 稳定低抖动
  const aiUnlocked = valid.filter((n) => n.unlock?.chatgpt === 'yes');
  const aiNonHK = valid.filter((n) => {
    const cc = String(n.unlock?.countryCode || '').toUpperCase();
    if (cc) return !['CN', 'HK', 'MO', 'RU'].includes(cc);
    return !/(香港|hong\s*kong|\bhk\b|澳门|macau)/i.test(String(n.name || ''));
  });
  const aiPool = aiUnlocked.length > 0 ? aiUnlocked : aiNonHK.length > 0 ? aiNonHK : valid;
  const aiNode = pickBest((n) => {
    let score = (n.steadySpeedMBps || 0) * 4 - n.latencyMs * 0.15 - getJitter(n) * 0.5;
    if (n.unlock?.ipType === 'residential') score += 35;
    else if (n.unlock?.ipType === 'mobile') score += 15;
    if (getLoss(n) === 0) score += 20;
    return score;
  }, aiPool);

  // 6. TikTok / 短视频刷流：兼顾首屏响应快 + 稳态预加载流畅 + 非香港落地优先
  const tiktokPool = aiNonHK.length > 0 ? aiNonHK : valid;
  const tiktokNode = pickBest((n) => {
    let score = Math.min(n.steadySpeedMBps || 0, 20) * 6 - n.latencyMs * 0.22 - getJitter(n) * 0.6;
    if (n.unlock?.ipType === 'residential') score += 20;
    if (n.unlock?.ipType === 'mobile') score += 15;
    return score;
  }, tiktokPool);

  // 7. Facebook / Instagram 社交图文与动态
  const socialNode = pickBest((n) => {
    const latScore = Math.max(0, 220 - n.latencyMs) * 0.35;
    const speedScore = Math.min(n.steadySpeedMBps || 0, 15) * 4.5;
    const jitterPenalty = getJitter(n) * 0.7;
    const ipBonus = n.unlock?.ipType === 'residential' ? 18 : 0;
    return latScore + speedScore - jitterPenalty + ipBonus;
  }, stablePool);

  // 8. 日常省流 / 高性价比
  const valueNode = pickBest((n) => n.valueScore || 0);

  return [
    {
      id: 'video',
      title: '4K 视频 / YouTube · NF',
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
      id: 'chat',
      title: 'WhatsApp / Telegram 聊天',
      icon: 'mdi:whatsapp',
      accentClass: 'text-[#25D366]',
      node: chatNode,
      metricText: chatNode
        ? `延迟 ${chatNode.latencyMs} ms${typeof chatNode.jitterMs === 'number' ? ` (±${chatNode.jitterMs})` : ''}`
        : '--',
      subText: chatNode
        ? `稳态 ${chatNode.steadySpeedMBps.toFixed(2)} MB/s · ${getLoss(chatNode)}%丢包`
        : '暂无可用节点',
      badge:
        chatNode && getLoss(chatNode) === 0 && getJitter(chatNode) <= 20
          ? { text: '稳连不掉线', variant: 'success' }
          : chatNode
            ? { text: '通话可用', variant: 'info' }
            : null,
    },
    {
      id: 'tiktok',
      title: 'TikTok / 短视频刷流',
      icon: 'mdi:music-note-outline',
      accentClass: 'text-[#FF2D55]',
      node: tiktokNode,
      metricText: tiktokNode ? `稳态 ${tiktokNode.steadySpeedMBps.toFixed(2)} MB/s` : '--',
      subText: tiktokNode
        ? `延迟 ${tiktokNode.latencyMs} ms${tiktokNode.unlock?.countryCode ? ` · ${tiktokNode.unlock.countryCode}` : ''}`
        : '暂无可用节点',
      badge:
        tiktokNode && tiktokNode.unlock?.ipType === 'residential'
          ? { text: '原生家宽优选', variant: 'success' }
          : tiktokNode && tiktokNode.steadySpeedMBps >= 3
            ? { text: '秒开预加载', variant: 'info' }
            : tiktokNode
              ? { text: '基础流畅', variant: 'warning' }
              : null,
    },
    {
      id: 'ai',
      title: 'ChatGPT / Claude AI 办公',
      icon: 'mdi:robot-outline',
      accentClass: 'text-[#A855F7]',
      node: aiNode,
      metricText: aiNode ? `延迟 ${aiNode.latencyMs} ms · ${aiNode.steadySpeedMBps.toFixed(1)} MB/s` : '--',
      subText: aiNode
        ? aiNode.unlock?.chatgpt === 'yes'
          ? `GPT已解锁 · ${aiNode.unlock.countryCode || '可用区'}`
          : aiNode.unlock?.ipType === 'residential'
            ? '原生家宽 · 低风控'
            : '非受限区域优选'
        : '暂无可用节点',
      badge:
        aiNode && aiNode.unlock?.chatgpt === 'yes'
          ? { text: 'GPT 已解锁', variant: 'success' }
          : aiNode
            ? { text: '低风控推荐', variant: 'info' }
            : null,
    },
    {
      id: 'social',
      title: 'Facebook / IG 社交浏览',
      icon: 'mdi:account-group-outline',
      accentClass: 'text-[#38BDF8]',
      node: socialNode,
      metricText: socialNode ? `稳态 ${socialNode.steadySpeedMBps.toFixed(2)} MB/s` : '--',
      subText: socialNode ? `延迟 ${socialNode.latencyMs} ms · ${socialNode.multiplier}x` : '暂无可用节点',
      badge:
        socialNode && socialNode.latencyMs <= 120 && socialNode.steadySpeedMBps >= 3
          ? { text: '图文秒刷', variant: 'success' }
          : socialNode
            ? { text: '稳定浏览', variant: 'info' }
            : null,
    },
    {
      id: 'download',
      title: '大文件 / GitHub 镜像下载',
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
      title: '游戏 / 低延迟实时交互',
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
