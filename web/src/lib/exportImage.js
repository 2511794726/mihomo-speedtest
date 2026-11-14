/**
 * 使用原生 HTML5 Canvas 2D 渲染高分辨率（2x DPI）测速排行榜长图。
 * 零外部依赖，避免 html2canvas 对 Tailwind v4 oklch() 色彩的兼容问题。
 */

const WIDTH = 1120
const DPR = 2
const PADDING_X = 36
const CONTENT_WIDTH = WIDTH - PADDING_X * 2
const FONT_SANS = '"Inter", "PingFang SC", "Microsoft YaHei", "Segoe UI", system-ui, sans-serif'
const FONT_MONO = '"JetBrains Mono", "Cascadia Code", "Consolas", monospace'

const SORT_LABELS = {
  steady: '稳态速度优先',
  avg: '均速优先',
  latency: '低延迟优先',
  value: '综合性价比优先',
}

function drawRoundedRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}

function fillAndStrokeRoundedRect(ctx, x, y, w, h, r, fillStyle, strokeStyle, lineWidth = 1) {
  drawRoundedRect(ctx, x, y, w, h, r)
  if (fillStyle) {
    ctx.fillStyle = fillStyle
    ctx.fill()
  }
  if (strokeStyle) {
    ctx.lineWidth = lineWidth
    ctx.strokeStyle = strokeStyle
    ctx.stroke()
  }
}

function truncateText(ctx, text, maxWidth) {
  const str = String(text ?? '')
  if (!str || ctx.measureText(str).width <= maxWidth) return str
  const ellipsis = '…'
  const ellipsisW = ctx.measureText(ellipsis).width
  let low = 0
  let high = str.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (ctx.measureText(str.slice(0, mid)).width + ellipsisW <= maxWidth) {
      low = mid
    } else {
      high = mid - 1
    }
  }
  return str.slice(0, low) + ellipsis
}

function formatTime(date) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function formatSpeed(val) {
  const n = Number(val)
  if (!Number.isFinite(n) || n <= 0) return '0.00 MB/s'
  return `${n.toFixed(2)} MB/s`
}

function formatLatency(ms) {
  if (ms === null || ms === undefined || ms < 0) return '超时'
  return `${Math.round(ms)} ms`
}

function latencyColor(ms) {
  if (ms === null || ms === undefined || ms < 0) return '#f87171'
  if (ms <= 120) return '#34d399'
  if (ms <= 260) return '#fbbf24'
  return '#fb7185'
}

function speedColor(speedMBps) {
  if (!speedMBps || speedMBps <= 0) return '#94a3b8'
  if (speedMBps >= 10) return '#34d399'
  if (speedMBps >= 3) return '#38bdf8'
  if (speedMBps >= 1) return '#fbbf24'
  return '#fb7185'
}

function statusBadgeMeta(status) {
  if (status === 'OK') {
    return { text: 'OK', bg: 'rgba(16, 185, 129, 0.16)', border: 'rgba(52, 211, 153, 0.45)', color: '#34d399' }
  }
  if (status === 'TIMEOUT') {
    return { text: '超时', bg: 'rgba(245, 158, 11, 0.16)', border: 'rgba(251, 191, 36, 0.45)', color: '#fbbf24' }
  }
  return { text: status || 'FAIL', bg: 'rgba(244, 63, 94, 0.16)', border: 'rgba(251, 113, 133, 0.45)', color: '#fb7185' }
}

function buildUnlockTags(unlock) {
  if (!unlock) return []
  const tags = []
  if (unlock.countryCode || unlock.country) {
    tags.push({
      text: unlock.countryCode || unlock.country,
      bg: 'rgba(56, 189, 248, 0.14)',
      border: 'rgba(56, 189, 248, 0.35)',
      color: '#7dd3fc',
    })
  }
  if (unlock.ipType) {
    const ipMeta =
      unlock.ipType === 'residential'
        ? { text: '家宽', bg: 'rgba(16, 185, 129, 0.14)', border: 'rgba(52, 211, 153, 0.38)', color: '#6ee7b7' }
        : unlock.ipType === 'mobile'
          ? { text: '移动', bg: 'rgba(56, 189, 248, 0.14)', border: 'rgba(56, 189, 248, 0.38)', color: '#7dd3fc' }
          : { text: '机房', bg: 'rgba(245, 158, 11, 0.14)', border: 'rgba(251, 191, 36, 0.35)', color: '#fcd34d' }
    tags.push(ipMeta)
  }
  const gpt = String(unlock.chatgpt || '').toLowerCase()
  if (gpt === 'yes') {
    tags.push({
      text: 'GPT ✓',
      bg: 'rgba(16, 185, 129, 0.14)',
      border: 'rgba(52, 211, 153, 0.38)',
      color: '#6ee7b7',
    })
  } else if (gpt === 'no') {
    tags.push({
      text: 'GPT ✗',
      bg: 'rgba(244, 63, 94, 0.12)',
      border: 'rgba(251, 113, 133, 0.32)',
      color: '#fda4af',
    })
  }
  const nf = String(unlock.netflix || '').toLowerCase()
  if (nf === 'full') {
    tags.push({
      text: 'NF 全解锁',
      bg: 'rgba(16, 185, 129, 0.14)',
      border: 'rgba(52, 211, 153, 0.38)',
      color: '#6ee7b7',
    })
  } else if (nf === 'originals') {
    tags.push({
      text: 'NF 自制',
      bg: 'rgba(56, 189, 248, 0.14)',
      border: 'rgba(56, 189, 248, 0.35)',
      color: '#7dd3fc',
    })
  }
  return tags
}

function drawTag(ctx, x, y, tag, fontSize = 10) {
  ctx.font = `600 ${fontSize}px ${FONT_SANS}`
  const textW = ctx.measureText(tag.text).width
  const w = textW + 10
  const h = 17
  fillAndStrokeRoundedRect(ctx, x, y, w, h, 4, tag.bg, tag.border, 1)
  ctx.fillStyle = tag.color
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.fillText(tag.text, x + 5, y + h / 2 + 0.5)
  return w
}

/**
 * 在目标 Canvas 上绘制测速排行榜长图。
 * @param {HTMLCanvasElement} canvas
 * @param {Object} options
 */
export function renderSpeedtestLongImage(canvas, options = {}) {
  const {
    rows = [],
    totalNodes = 0,
    okNodes = 0,
    totalBytesText = '0 B',
    elapsedText = '0s',
    fastestNode = null,
    sortBy = 'steady',
    concurrency = 4,
    peakBandwidthMBps = 0,
    bandwidthCapMBps = 0,
    sceneRecommendations = [],
    scopeLabel = '全部节点',
    generatedAt = new Date(),
  } = options

  const hasScenes = Array.isArray(sceneRecommendations) && sceneRecommendations.length > 0
  const headerH = 112
  const summaryH = 88
  const sceneSectionH = hasScenes ? 114 : 0
  const tableHeaderH = 40
  const rowH = 54
  const emptyRowH = 90
  const rowsAreaH = rows.length > 0 ? rows.length * rowH : emptyRowH
  const footerH = 54
  const sectionGap = 18

  const totalHeight =
    28 +
    headerH +
    sectionGap +
    summaryH +
    (hasScenes ? sectionGap + sceneSectionH : 0) +
    sectionGap +
    tableHeaderH +
    rowsAreaH +
    12 +
    footerH +
    20

  canvas.width = WIDTH * DPR
  canvas.height = totalHeight * DPR

  const ctx = canvas.getContext('2d')
  ctx.save()
  ctx.scale(DPR, DPR)

  // 背景渐变
  const bgGrad = ctx.createLinearGradient(0, 0, 0, totalHeight)
  bgGrad.addColorStop(0, '#070b14')
  bgGrad.addColorStop(0.5, '#0b1220')
  bgGrad.addColorStop(1, '#070b14')
  ctx.fillStyle = bgGrad
  ctx.fillRect(0, 0, WIDTH, totalHeight)

  // 顶部装饰光晕
  const glowLeft = ctx.createRadialGradient(180, 40, 10, 180, 40, 380)
  glowLeft.addColorStop(0, 'rgba(56, 189, 248, 0.16)')
  glowLeft.addColorStop(1, 'rgba(56, 189, 248, 0)')
  ctx.fillStyle = glowLeft
  ctx.fillRect(0, 0, WIDTH, 420)

  const glowRight = ctx.createRadialGradient(WIDTH - 160, 80, 10, WIDTH - 160, 80, 340)
  glowRight.addColorStop(0, 'rgba(16, 185, 129, 0.12)')
  glowRight.addColorStop(1, 'rgba(16, 185, 129, 0)')
  ctx.fillStyle = glowRight
  ctx.fillRect(0, 0, WIDTH, 420)

  let cursorY = 28

  // 1. Header 卡片
  fillAndStrokeRoundedRect(
    ctx,
    PADDING_X,
    cursorY,
    CONTENT_WIDTH,
    headerH,
    16,
    'rgba(15, 23, 42, 0.85)',
    'rgba(148, 163, 184, 0.18)',
    1
  )

  // 左侧品牌标识条
  const accentGrad = ctx.createLinearGradient(PADDING_X + 22, cursorY + 22, PADDING_X + 22, cursorY + 66)
  accentGrad.addColorStop(0, '#38bdf8')
  accentGrad.addColorStop(1, '#10b981')
  fillAndStrokeRoundedRect(ctx, PADDING_X + 22, cursorY + 24, 5, 42, 3, accentGrad, null)

  ctx.textBaseline = 'top'
  ctx.textAlign = 'left'
  ctx.fillStyle = '#f8fafc'
  ctx.font = `700 24px ${FONT_SANS}`
  ctx.fillText('Mihomo Speedtest 测速排行榜', PADDING_X + 40, cursorY + 22)

  ctx.fillStyle = '#94a3b8'
  ctx.font = `500 12.5px ${FONT_SANS}`
  const metaParts = [
    `排序: ${SORT_LABELS[sortBy] || sortBy}`,
    `范围: ${scopeLabel} (${rows.length} 条)`,
    `并发: ${concurrency} 线程`,
    bandwidthCapMBps > 0 ? `限速阈值: ${bandwidthCapMBps.toFixed(1)} MB/s` : null,
    peakBandwidthMBps > 0 ? `本地实测峰值: ${peakBandwidthMBps.toFixed(1)} MB/s` : null,
  ].filter(Boolean)
  ctx.fillText(metaParts.join('   ·   '), PADDING_X + 40, cursorY + 58)

  // 右上角时间戳与徽章
  ctx.textAlign = 'right'
  ctx.fillStyle = '#38bdf8'
  ctx.font = `600 12px ${FONT_MONO}`
  ctx.fillText(formatTime(generatedAt), PADDING_X + CONTENT_WIDTH - 22, cursorY + 26)

  ctx.fillStyle = '#64748b'
  ctx.font = `500 11.5px ${FONT_SANS}`
  ctx.fillText('Mihomo 内核 · 真实下载测速报告', PADDING_X + CONTENT_WIDTH - 22, cursorY + 58)

  cursorY += headerH + sectionGap

  // 2. 4 个汇总指标卡片
  const cardGap = 14
  const cardW = (CONTENT_WIDTH - cardGap * 3) / 4
  const summaryCards = [
    {
      label: '可用 / 总节点',
      value: `${okNodes} / ${totalNodes}`,
      sub: totalNodes > 0 ? `可用率 ${Math.round((okNodes / totalNodes) * 100)}%` : '暂无节点',
      accent: '#34d399',
    },
    {
      label: '累计测速流量',
      value: totalBytesText,
      sub: '真实下载字节统计',
      accent: '#38bdf8',
    },
    {
      label: '测速总耗时',
      value: elapsedText,
      sub: `${concurrency} 并发执行`,
      accent: '#a78bfa',
    },
    {
      label: '最快稳态节点',
      value: fastestNode ? formatSpeed(fastestNode.steadySpeedMBps) : '--',
      sub: fastestNode ? fastestNode.name : '暂无可用节点',
      accent: '#fbbf24',
    },
  ]

  summaryCards.forEach((card, idx) => {
    const cx = PADDING_X + idx * (cardW + cardGap)
    fillAndStrokeRoundedRect(
      ctx,
      cx,
      cursorY,
      cardW,
      summaryH,
      14,
      'rgba(15, 23, 42, 0.78)',
      'rgba(148, 163, 184, 0.16)',
      1
    )
    // 顶部细色条
    fillAndStrokeRoundedRect(ctx, cx + 16, cursorY + 14, 24, 3, 2, card.accent, null)

    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    ctx.fillStyle = '#94a3b8'
    ctx.font = `500 11.5px ${FONT_SANS}`
    ctx.fillText(card.label, cx + 16, cursorY + 23)

    ctx.fillStyle = '#f8fafc'
    ctx.font = `700 20px ${FONT_MONO}`
    ctx.fillText(truncateText(ctx, card.value, cardW - 32), cx + 16, cursorY + 42)

    ctx.fillStyle = '#64748b'
    ctx.font = `500 11px ${FONT_SANS}`
    ctx.fillText(truncateText(ctx, card.sub, cardW - 32), cx + 16, cursorY + 67)
  })

  cursorY += summaryH + sectionGap

  // 3. 场景推荐卡片（如有）
  if (hasScenes) {
    const scList = sceneRecommendations.slice(0, 4)
    const scW = (CONTENT_WIDTH - cardGap * (scList.length - 1)) / scList.length

    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    ctx.fillStyle = '#cbd5e1'
    ctx.font = `600 13px ${FONT_SANS}`
    ctx.fillText('场景优选推荐', PADDING_X + 2, cursorY)

    const scBoxY = cursorY + 24
    const scBoxH = sceneSectionH - 24
    scList.forEach((sc, idx) => {
      const sx = PADDING_X + idx * (scW + cardGap)
      fillAndStrokeRoundedRect(
        ctx,
        sx,
        scBoxY,
        scW,
        scBoxH,
        12,
        'rgba(15, 23, 42, 0.72)',
        'rgba(56, 189, 248, 0.22)',
        1
      )
      ctx.fillStyle = '#38bdf8'
      ctx.font = `600 11.5px ${FONT_SANS}`
      ctx.fillText(truncateText(ctx, sc.title || sc.label || '推荐场景', scW - 28), sx + 14, scBoxY + 12)

      ctx.fillStyle = '#f8fafc'
      ctx.font = `600 13.5px ${FONT_SANS}`
      ctx.fillText(truncateText(ctx, sc.node?.name || '--', scW - 28), sx + 14, scBoxY + 34)

      ctx.fillStyle = '#94a3b8'
      ctx.font = `500 11.5px ${FONT_MONO}`
      const detail = sc.node
        ? `${formatSpeed(sc.node.steadySpeedMBps)} · ${formatLatency(sc.node.latencyMs)}`
        : sc.reason || ''
      ctx.fillText(truncateText(ctx, detail, scW - 28), sx + 14, scBoxY + 58)
    })

    cursorY += sceneSectionH + sectionGap
  }

  // 4. 排行榜主表格容器
  const tableHeight = tableHeaderH + rowsAreaH
  fillAndStrokeRoundedRect(
    ctx,
    PADDING_X,
    cursorY,
    CONTENT_WIDTH,
    tableHeight,
    16,
    'rgba(15, 23, 42, 0.82)',
    'rgba(148, 163, 184, 0.18)',
    1
  )

  // 列定义（总宽 = CONTENT_WIDTH = 1048）
  const cols = [
    { key: 'rank', label: '#', x: PADDING_X + 18, w: 46, align: 'center' },
    { key: 'name', label: '节点名称 / 地区解锁', x: PADDING_X + 70, w: 350, align: 'left' },
    { key: 'type', label: '协议', x: PADDING_X + 428, w: 84, align: 'center' },
    { key: 'mult', label: '倍率', x: PADDING_X + 518, w: 56, align: 'center' },
    { key: 'latency', label: '延迟', x: PADDING_X + 580, w: 80, align: 'right' },
    { key: 'avg', label: '平均速度', x: PADDING_X + 670, w: 108, align: 'right' },
    { key: 'steady', label: '稳态速度', x: PADDING_X + 788, w: 148, align: 'right' },
    { key: 'score', label: '评分 / 状态', x: PADDING_X + 946, w: 86, align: 'right' },
  ]

  // 表头背景
  drawRoundedRect(ctx, PADDING_X, cursorY, CONTENT_WIDTH, tableHeaderH, 16)
  ctx.save()
  ctx.clip()
  ctx.fillStyle = 'rgba(30, 41, 59, 0.72)'
  ctx.fillRect(PADDING_X, cursorY, CONTENT_WIDTH, tableHeaderH)
  ctx.restore()

  ctx.strokeStyle = 'rgba(148, 163, 184, 0.14)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(PADDING_X, cursorY + tableHeaderH)
  ctx.lineTo(PADDING_X + CONTENT_WIDTH, cursorY + tableHeaderH)
  ctx.stroke()

  ctx.fillStyle = '#94a3b8'
  ctx.font = `600 11.5px ${FONT_SANS}`
  ctx.textBaseline = 'middle'
  cols.forEach((col) => {
    ctx.textAlign = col.align
    const tx = col.align === 'right' ? col.x + col.w : col.align === 'center' ? col.x + col.w / 2 : col.x
    ctx.fillText(col.label, tx, cursorY + tableHeaderH / 2)
  })

  const maxSteadySpeed = Math.max(
    1,
    ...rows.map((r) => (r.status === 'OK' ? Number(r.steadySpeedMBps) || 0 : 0))
  )

  let rowY = cursorY + tableHeaderH

  if (rows.length === 0) {
    ctx.fillStyle = '#64748b'
    ctx.font = `500 14px ${FONT_SANS}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('当前筛选范围内暂无可导出的测速结果', PADDING_X + CONTENT_WIDTH / 2, rowY + emptyRowH / 2)
  } else {
    rows.forEach((item, index) => {
      const isEven = index % 2 === 1
      if (isEven) {
        ctx.fillStyle = 'rgba(30, 41, 59, 0.28)'
        ctx.fillRect(PADDING_X + 1, rowY, CONTENT_WIDTH - 2, rowH)
      }

      if (index > 0) {
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.08)'
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(PADDING_X + 12, rowY)
        ctx.lineTo(PADDING_X + CONTENT_WIDTH - 12, rowY)
        ctx.stroke()
      }

      const rank = index + 1
      const centerY = rowY + rowH / 2

      // # 排名徽章
      const rankCol = cols[0]
      const rankCx = rankCol.x + rankCol.w / 2
      if (rank <= 3) {
        const medalColors = [
          { bg: 'rgba(251, 191, 36, 0.2)', border: 'rgba(251, 191, 36, 0.55)', text: '#fbbf24' },
          { bg: 'rgba(203, 213, 225, 0.2)', border: 'rgba(203, 213, 225, 0.5)', text: '#e2e8f0' },
          { bg: 'rgba(251, 146, 60, 0.2)', border: 'rgba(251, 146, 60, 0.5)', text: '#fb923c' },
        ][rank - 1]
        fillAndStrokeRoundedRect(ctx, rankCx - 14, centerY - 12, 28, 24, 7, medalColors.bg, medalColors.border, 1)
        ctx.fillStyle = medalColors.text
        ctx.font = `700 12px ${FONT_MONO}`
      } else {
        ctx.fillStyle = '#94a3b8'
        ctx.font = `600 12px ${FONT_MONO}`
      }
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(String(rank), rankCx, centerY + 0.5)

      // 节点名称 + 解锁徽章
      const nameCol = cols[1]
      const tags = buildUnlockTags(item.unlock)
      ctx.textAlign = 'left'
      ctx.fillStyle = item.status === 'OK' ? '#f8fafc' : '#94a3b8'
      ctx.font = `600 13px ${FONT_SANS}`
      if (tags.length > 0) {
        ctx.textBaseline = 'top'
        ctx.fillText(truncateText(ctx, item.name, nameCol.w), nameCol.x, rowY + 8)
        let tagX = nameCol.x
        for (const tag of tags) {
          const w = drawTag(ctx, tagX, rowY + 29, tag, 9.5)
          tagX += w + 5
        }
      } else {
        ctx.textBaseline = 'middle'
        ctx.fillText(truncateText(ctx, item.name, nameCol.w), nameCol.x, centerY)
      }

      // 协议
      const typeCol = cols[2]
      const typeText = String(item.type || 'unknown').toUpperCase()
      fillAndStrokeRoundedRect(
        ctx,
        typeCol.x + 8,
        centerY - 11,
        typeCol.w - 16,
        22,
        6,
        'rgba(51, 65, 85, 0.55)',
        'rgba(148, 163, 184, 0.22)',
        1
      )
      ctx.fillStyle = '#cbd5e1'
      ctx.font = `600 10.5px ${FONT_MONO}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(truncateText(ctx, typeText, typeCol.w - 22), typeCol.x + typeCol.w / 2, centerY + 0.5)

      // 倍率
      const multCol = cols[3]
      const multVal = Number(item.multiplier)
      const multText = Number.isFinite(multVal) && multVal > 0 ? `${multVal}x` : '1x'
      ctx.fillStyle = multVal > 1 ? '#fbbf24' : '#94a3b8'
      ctx.font = `600 12px ${FONT_MONO}`
      ctx.textAlign = 'center'
      ctx.fillText(multText, multCol.x + multCol.w / 2, centerY + 0.5)

      // 延迟 + 抖动
      const latCol = cols[4]
      ctx.fillStyle = latencyColor(item.latencyMs)
      ctx.font = `600 12.5px ${FONT_MONO}`
      ctx.textAlign = 'right'
      if (item.latencyMs !== null && item.jitterMs !== undefined && item.jitterMs !== null) {
        ctx.textBaseline = 'top'
        ctx.fillText(formatLatency(item.latencyMs), latCol.x + latCol.w, rowY + 11)
        ctx.fillStyle = item.jitterMs <= 15 ? '#6ee7b7' : item.jitterMs <= 50 ? '#fbbf24' : '#fda4af'
        ctx.font = `500 10px ${FONT_MONO}`
        const lossText = item.packetLoss > 0 ? ` · ${item.packetLoss}%丢` : ''
        ctx.fillText(`±${item.jitterMs}ms${lossText}`, latCol.x + latCol.w, rowY + 31)
      } else {
        ctx.textBaseline = 'middle'
        ctx.fillText(formatLatency(item.latencyMs), latCol.x + latCol.w, centerY + 0.5)
      }

      // 平均速度
      const avgCol = cols[5]
      ctx.fillStyle = item.status === 'OK' ? '#cbd5e1' : '#64748b'
      ctx.font = `500 12.5px ${FONT_MONO}`
      ctx.textAlign = 'right'
      ctx.fillText(item.status === 'OK' ? formatSpeed(item.avgSpeedMBps) : '--', avgCol.x + avgCol.w, centerY + 0.5)

      // 稳态速度 + 进度条
      const steadyCol = cols[6]
      const steadyVal = Number(item.steadySpeedMBps) || 0
      if (item.status === 'OK') {
        ctx.fillStyle = speedColor(steadyVal)
        ctx.font = `700 13px ${FONT_MONO}`
        ctx.textAlign = 'right'
        ctx.textBaseline = 'top'
        ctx.fillText(formatSpeed(steadyVal), steadyCol.x + steadyCol.w, rowY + 11)

        const barW = 120
        const barH = 5
        const barX = steadyCol.x + steadyCol.w - barW
        const barY = rowY + 34
        fillAndStrokeRoundedRect(ctx, barX, barY, barW, barH, 3, 'rgba(51, 65, 85, 0.7)', null)
        const ratio = Math.max(0.04, Math.min(1, steadyVal / maxSteadySpeed))
        fillAndStrokeRoundedRect(ctx, barX, barY, barW * ratio, barH, 3, speedColor(steadyVal), null)
      } else {
        ctx.fillStyle = '#64748b'
        ctx.font = `500 12.5px ${FONT_MONO}`
        ctx.textAlign = 'right'
        ctx.textBaseline = 'middle'
        ctx.fillText('--', steadyCol.x + steadyCol.w, centerY)
      }

      // 评分 / 状态
      const scoreCol = cols[7]
      if (item.status === 'OK') {
        const score = Number(item.valueScore)
        ctx.fillStyle = '#f8fafc'
        ctx.font = `700 13px ${FONT_MONO}`
        ctx.textAlign = 'right'
        ctx.textBaseline = 'middle'
        ctx.fillText(Number.isFinite(score) ? score.toFixed(1) : '--', scoreCol.x + scoreCol.w, centerY + 0.5)
      } else {
        const badge = statusBadgeMeta(item.status)
        const bw = 54
        const bh = 22
        fillAndStrokeRoundedRect(ctx, scoreCol.x + scoreCol.w - bw, centerY - bh / 2, bw, bh, 6, badge.bg, badge.border, 1)
        ctx.fillStyle = badge.color
        ctx.font = `600 10.5px ${FONT_SANS}`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(badge.text, scoreCol.x + scoreCol.w - bw / 2, centerY + 0.5)
      }

      rowY += rowH
    })
  }

  cursorY += tableHeight + 16

  // 5. Footer
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.fillStyle = '#64748b'
  ctx.font = `500 11.5px ${FONT_SANS}`
  ctx.fillText('Generated by Mihomo Speedtest · github.com/2511794726/mihomo-speedtest', PADDING_X + 6, cursorY + 18)

  ctx.textAlign = 'right'
  ctx.fillStyle = '#475569'
  ctx.font = `500 11.5px ${FONT_MONO}`
  ctx.fillText(`${WIDTH * DPR}×${totalHeight * DPR}px @2x`, PADDING_X + CONTENT_WIDTH - 6, cursorY + 18)

  ctx.restore()
  return { width: WIDTH, height: totalHeight }
}
