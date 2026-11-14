package main

import (
	"context"
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"io/fs"
	"math"
	"mime"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"mihomo-speedtest/internal/config"
	"mihomo-speedtest/internal/mihomo"
	"mihomo-speedtest/internal/preflight"
	"mihomo-speedtest/internal/report"
	"mihomo-speedtest/internal/subscribe"
	"mihomo-speedtest/internal/tester"
	"mihomo-speedtest/internal/vpn"
)

//go:embed all:web/dist
var embeddedDist embed.FS

type sseClient chan string

type JobState struct {
	mu           sync.Mutex
	running      bool
	stage        string
	total        int
	completed    int
	sortBy       string
	startedAtMs  int64
	elapsedMs    int64
	totalBytes   int64
	results      []tester.NodeResult
	logs         []string
	cancel       context.CancelFunc
	activeMihomo *mihomo.Instance
	scaleFn      func(int) (int, bool)
	clients      map[sseClient]struct{}
}

func newJobState() *JobState {
	return &JobState{
		stage:   "idle",
		sortBy:  "avg",
		results: []tester.NodeResult{},
		logs:    []string{},
		clients: make(map[sseClient]struct{}),
	}
}

func (j *JobState) broadcast(event string, data any) {
	b, _ := json.Marshal(data)
	msg := fmt.Sprintf("event: %s\ndata: %s\n\n", event, string(b))
	j.mu.Lock()
	defer j.mu.Unlock()
	for ch := range j.clients {
		select {
		case ch <- msg:
		default:
		}
	}
}

func (j *JobState) pushLog(message string) {
	entry := fmt.Sprintf("[%s] %s", time.Now().Format("15:04:05"), message)
	j.mu.Lock()
	j.logs = append(j.logs, entry)
	if len(j.logs) > 200 {
		j.logs = j.logs[len(j.logs)-200:]
	}
	j.mu.Unlock()
	j.broadcast("log", map[string]string{"message": entry})
}

func (j *JobState) stopActive() {
	j.mu.Lock()
	cancel := j.cancel
	inst := j.activeMihomo
	j.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if inst != nil {
		_ = inst.Stop()
	}
}

func sendJSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(data)
}

func openBrowser(urlStr string) {
	switch runtime.GOOS {
	case "windows":
		_ = exec.Command("cmd", "/c", "start", "", urlStr).Start()
	case "darwin":
		_ = exec.Command("open", urlStr).Start()
	default:
		_ = exec.Command("xdg-open", urlStr).Start()
	}
}

func main() {
	portFlag := flag.Int("port", 19190, "Web 服务起始端口")
	hostFlag := flag.String("host", "127.0.0.1", "监听地址 (服务器部署可设为 0.0.0.0)")
	noOpen := flag.Bool("no-open", false, "启动后不自动打开浏览器")
	flag.Parse()

	if envHost := os.Getenv("HOST"); envHost != "" {
		*hostFlag = envHost
	}
	if envPort := os.Getenv("UI_PORT"); envPort != "" {
		if p, err := strconv.Atoi(envPort); err == nil && p > 0 {
			*portFlag = p
		}
	}

	exePath, _ := os.Executable()
	rootDir, _ := os.Getwd()
	if exePath != "" && !strings.Contains(strings.ToLower(exePath), "go-build") {
		rootDir = filepath.Dir(exePath)
	}

	settingsPath := filepath.Join(rootDir, "settings.json")
	configsDir := filepath.Join(rootDir, "configs")
	binDir := filepath.Join(rootDir, "bin")
	outputPath := filepath.Join(rootDir, "results", "speed-rank.json")
	historyDir := filepath.Join(rootDir, "results", "history")

	job := newJobState()

	runJob := func(sortBy string, limit int, selectedNodes []string, enableUnlockOverride *bool, concurrencyOverride *int, maxBandwidthOverride *float64) {
		ctx, cancel := context.WithCancel(context.Background())
		startedAt := time.Now()
		startedAtMs := startedAt.UnixMilli()

		job.mu.Lock()
		job.running = true
		job.stage = "preflight"
		job.total = 0
		job.completed = 0
		job.sortBy = sortBy
		job.startedAtMs = startedAtMs
		job.elapsedMs = 0
		job.totalBytes = 0
		job.results = []tester.NodeResult{}
		job.logs = []string{}
		job.cancel = cancel
		job.mu.Unlock()

		job.broadcast("state", map[string]any{
			"running": true, "stage": "preflight", "total": 0, "completed": 0, "sortBy": sortBy,
			"startedAtMs": startedAtMs, "elapsedMs": 0, "totalBytes": 0,
		})

		defer func() {
			cancel()
			finalElapsed := time.Since(startedAt).Milliseconds()
			job.mu.Lock()
			job.running = false
			job.stage = "idle"
			job.cancel = nil
			job.activeMihomo = nil
			job.scaleFn = nil
			if job.elapsedMs == 0 {
				job.elapsedMs = finalElapsed
			}
			tot := job.total
			comp := job.completed
			sb := job.sortBy
			tb := job.totalBytes
			el := job.elapsedMs
			job.mu.Unlock()
			job.broadcast("state", map[string]any{
				"running": false, "stage": "idle", "total": tot, "completed": comp, "sortBy": sb,
				"startedAtMs": startedAtMs, "elapsedMs": el, "totalBytes": tb,
			})
		}()

		settings, _, err := config.LoadSettings(settingsPath)
		if err != nil {
			job.pushLog("读取配置失败: " + err.Error())
			job.broadcast("error", map[string]string{"message": err.Error()})
			return
		}
		if enableUnlockOverride != nil {
			settings.EnableUnlockCheck = *enableUnlockOverride
		}
		if concurrencyOverride != nil && *concurrencyOverride >= 1 && *concurrencyOverride <= 16 {
			settings.Concurrency = *concurrencyOverride
		}
		if maxBandwidthOverride != nil && *maxBandwidthOverride >= 0 {
			settings.MaxBandwidthMBps = *maxBandwidthOverride
		}
		concurrency := settings.Concurrency
		if concurrency < 1 {
			concurrency = 1
		}
		if concurrency > 16 {
			concurrency = 16
		}
		if settings.MaxBandwidthMBps <= 0 && concurrency > 1 {
			concurrency = 1
			job.pushLog("未设置全局宽带上限，已自动锁定为 1 线程串行测速（设置宽带上限后可开启多线程）。")
		}

		job.pushLog(fmt.Sprintf("正在预检端口与 Mihomo 内核 (初始线程: %d，预挂载最多 16 端口以支持热扩容)...", concurrency))
		workerPorts, controllerPort, err := preflight.ResolveWorkerPorts(settings.MixedPort, settings.ControllerPort, 16)
		if err != nil {
			job.pushLog("端口预检失败: " + err.Error())
			job.broadcast("error", map[string]string{"message": err.Error()})
			return
		}
		binPath, err := preflight.EnsureMihomoBinary(binDir)
		if err != nil {
			job.pushLog("内核定位失败: " + err.Error())
			job.broadcast("error", map[string]string{"message": err.Error()})
			return
		}
		job.pushLog(fmt.Sprintf("内核就绪: %s (workerPorts=%v, controllerPort=%d)", binPath, workerPorts, controllerPort))

		if ctx.Err() != nil {
			return
		}

		job.mu.Lock()
		job.stage = "subscribe"
		job.mu.Unlock()
		job.broadcast("state", map[string]any{
			"running": true, "stage": "subscribe", "total": 0, "completed": 0, "sortBy": sortBy,
		})
		job.pushLog("正在拉取并解析订阅...")

		subInfo, err := subscribe.PrepareRuntimeSubscriptionWithWorkers(settings, workerPorts, controllerPort, configsDir)
		if err != nil {
			job.pushLog("订阅解析失败: " + err.Error())
			job.broadcast("error", map[string]string{"message": err.Error()})
			return
		}
		uaNote := ""
		if subInfo.UsedUserAgent != "" {
			uaNote = " / " + subInfo.UsedUserAgent
		}
		job.pushLog(fmt.Sprintf("订阅解析完成 (%s / %s%s)", subInfo.Source, subInfo.Format, uaNote))

		if ctx.Err() != nil {
			return
		}

		job.mu.Lock()
		job.stage = "starting-core"
		job.mu.Unlock()
		job.broadcast("state", map[string]any{
			"running": true, "stage": "starting-core", "total": 0, "completed": 0, "sortBy": sortBy,
		})
		job.pushLog("正在拉起 Mihomo 内核...")

		inst, err := mihomo.StartProcess(binPath, configsDir, subInfo.RuntimeYAMLPath, controllerPort, settings.ControllerSecret, subInfo.HasProviders)
		if err != nil {
			job.pushLog("拉起内核失败: " + err.Error())
			job.broadcast("error", map[string]string{"message": err.Error()})
			return
		}
		job.mu.Lock()
		job.activeMihomo = inst
		job.mu.Unlock()
		defer inst.Stop()

		nodes, err := inst.FetchFilteredProxies(settings.ExcludeKeywords, settings.IncludeRegions, settings.IncludeKeywords, settings.RegionKeywords)
		if err != nil {
			job.pushLog("获取节点失败: " + err.Error())
			job.broadcast("error", map[string]string{"message": err.Error()})
			return
		}
		if len(nodes) == 0 {
			job.pushLog("未发现任何符合条件的有效出站节点。")
			return
		}
		if len(selectedNodes) > 0 {
			selectedSet := make(map[string]bool, len(selectedNodes))
			for _, sn := range selectedNodes {
				selectedSet[sn] = true
			}
			filtered := make([]mihomo.ProxyNode, 0, len(selectedNodes))
			for _, n := range nodes {
				if selectedSet[n.Name] {
					filtered = append(filtered, n)
				}
			}
			if len(filtered) == 0 {
				job.pushLog("所选节点均不在当前订阅中。")
				return
			}
			job.pushLog(fmt.Sprintf("已按预览勾选锁定 %d 个节点，开始串行测速...", len(filtered)))
			nodes = filtered
		} else if limit > 0 && len(nodes) > limit {
			job.pushLog(fmt.Sprintf("共发现 %d 个有效节点，按设置抽测前 %d 个节点...", len(nodes), limit))
			nodes = nodes[:limit]
		} else {
			job.pushLog(fmt.Sprintf("共发现 %d 个有效节点，开始串行双阶段测速...", len(nodes)))
		}

		job.mu.Lock()
		job.stage = "testing"
		job.total = len(nodes)
		job.mu.Unlock()
		job.broadcast("state", map[string]any{
			"running": true, "stage": "testing", "total": len(nodes), "completed": 0, "sortBy": sortBy,
			"startedAtMs": startedAtMs, "elapsedMs": time.Since(startedAt).Milliseconds(), "totalBytes": int64(0),
		})

		limiter := tester.NewBandwidthLimiter(settings.MaxBandwidthMBps)
		if settings.MaxBandwidthMBps > 0 {
			job.pushLog(fmt.Sprintf("已启用智能防封顶退避: 宽带阈值 %.1f MB/s (约 %.0f Mbps)，初始并发 %d 线程（不锁单线程速度，触顶自动降线程并重测）", settings.MaxBandwidthMBps, settings.MaxBandwidthMBps*8, concurrency))
		} else {
			job.pushLog("已开启 1 线程串行精确测速")
		}

		warnedBandwidth := false
		lastSuggestUpThreads := 0
		var lastAutoScaleDownAt time.Time
		peakMBps := 0.0
		activeSamples := 0
		var warnMu sync.Mutex

		ctrl := tester.NewConcurrencyController(concurrency, len(workerPorts))
		ctrl.OnCongestedRetry = func(nodeName string, attempt int) {
			job.pushLog(fmt.Sprintf("[防封顶重测] 节点 %s 测速期间总速率触顶，已退回队列等待降线程后重测 (第 %d 次)", nodeName, attempt))
		}
		job.mu.Lock()
		job.scaleFn = func(next int) (int, bool) {
			warnMu.Lock()
			prev := ctrl.Target()
			applied := ctrl.SetTarget(next)
			activeSamples = 0
			lastSuggestUpThreads = 0
			if applied < prev {
				warnedBandwidth = false
			}
			warnMu.Unlock()
			if applied != prev {
				job.pushLog(fmt.Sprintf("[并发热调整] 线程数已实时变更为 %d -> %d 线程（立即应用于剩余节点）", prev, applied))
				job.broadcast("concurrency-updated", map[string]any{
					"concurrency": applied,
					"previous":    prev,
				})
				return applied, true
			}
			return applied, false
		}
		job.mu.Unlock()

		monitorCtx, stopMonitor := context.WithCancel(ctx)
		defer stopMonitor()
		go func() {
			ticker := time.NewTicker(300 * time.Millisecond)
			defer ticker.Stop()
			for {
				select {
				case <-monitorCtx.Done():
					return
				case <-ticker.C:
					curMBps, throttled := limiter.Snapshot()
					curConcurrency := ctrl.Target()

					job.mu.Lock()
					remainingNodes := job.total - job.completed
					job.mu.Unlock()

					warnMu.Lock()
					if curMBps > peakMBps {
						peakMBps = curMBps
					}
					if curMBps >= 0.5 {
						activeSamples++
					}
					curPeak := peakMBps
					samples := activeSamples
					alreadyWarned := warnedBandwidth
					prevSuggestUp := lastSuggestUpThreads
					warnMu.Unlock()

					job.broadcast("bandwidth", map[string]any{
						"currentMBps": curMBps,
						"peakMBps":    curPeak,
						"limitMBps":   settings.MaxBandwidthMBps,
						"throttled":   throttled,
						"concurrency": curConcurrency,
						"totalBytes":  limiter.TotalBytes(),
						"elapsedMs":   time.Since(startedAt).Milliseconds(),
					})

					if curConcurrency > 1 && settings.MaxBandwidthMBps > 0 && (throttled || curMBps >= settings.MaxBandwidthMBps*0.92) {
						limiter.MarkCongested()
						limiter.ClearThrottled()
						warnMu.Lock()
						canScale := time.Since(lastAutoScaleDownAt) >= 2500*time.Millisecond
						if canScale {
							lastAutoScaleDownAt = time.Now()
							warnedBandwidth = true
							lastSuggestUpThreads = 0
						}
						warnMu.Unlock()
						if canScale {
							step := curConcurrency / 4
							if step < 1 {
								step = 1
							}
							nextThreads := curConcurrency - step
							if nextThreads < 1 {
								nextThreads = 1
							}
							if nextThreads < curConcurrency {
								ctrl.SetTarget(nextThreads)
								warnMu.Lock()
								activeSamples = 0
								warnMu.Unlock()
								warnMsg := fmt.Sprintf("总速率已触及 %.1f MB/s 上限，已自动从 %d 线程降至 %d 线程，并将受竞争影响的高速节点放回队列重测以保证测速真实性。", settings.MaxBandwidthMBps, curConcurrency, nextThreads)
								job.pushLog("[智能降线程] " + warnMsg)
								job.broadcast("concurrency-updated", map[string]any{
									"concurrency": nextThreads,
									"previous":    curConcurrency,
								})
								job.broadcast("bandwidth-warning", map[string]any{
									"level":              "auto-scaled-down",
									"message":            warnMsg,
									"currentMBps":        curMBps,
									"peakMBps":           curPeak,
									"limitMBps":          settings.MaxBandwidthMBps,
									"concurrency":        nextThreads,
									"recommendedThreads": nextThreads,
									"remaining":          remainingNodes,
								})
							}
						}
					} else if !alreadyWarned && curConcurrency < 16 && settings.MaxBandwidthMBps > 0 && samples >= 6 && curPeak >= 0.5 && remainingNodes >= 4 {
						usageRatio := curPeak / settings.MaxBandwidthMBps
						recUp := 0
						if usageRatio < 0.72 {
							perThreadPeak := curPeak / float64(curConcurrency)
							if perThreadPeak < 1.0 {
								perThreadPeak = 1.0
							}
							estMax := int(math.Floor((settings.MaxBandwidthMBps * 0.85) / perThreadPeak))
							if estMax > 16 {
								estMax = 16
							}
							if estMax > curConcurrency {
								recUp = estMax
							}
						}

						if recUp > curConcurrency && recUp != prevSuggestUp {
							warnMu.Lock()
							if !warnedBandwidth {
								lastSuggestUpThreads = recUp
								warnMu.Unlock()
								suggestMsg := fmt.Sprintf("当前 %d 线程网速最高峰为 %.1f MB/s（占预设上限 %.1f MB/s 的 %.0f%%），宽带余量充足，可尝试将线程提高至 %d 线程以加快测速。", curConcurrency, curPeak, settings.MaxBandwidthMBps, usageRatio*100, recUp)
								if prevSuggestUp == 0 {
									job.pushLog("[并发建议] " + suggestMsg)
								}
								job.broadcast("bandwidth-warning", map[string]any{
									"level":              "suggest-up",
									"message":            suggestMsg,
									"currentMBps":        curMBps,
									"peakMBps":           curPeak,
									"limitMBps":          settings.MaxBandwidthMBps,
									"concurrency":        curConcurrency,
									"recommendedThreads": recUp,
									"remaining":          remainingNodes,
									"usageRatio":         usageRatio,
								})
							} else {
								warnMu.Unlock()
							}
						} else if recUp == 0 && prevSuggestUp > 0 {
							warnMu.Lock()
							if !warnedBandwidth && lastSuggestUpThreads > 0 {
								lastSuggestUpThreads = 0
								warnMu.Unlock()
								job.broadcast("bandwidth-warning", map[string]any{
									"level":       "clear",
									"peakMBps":    curPeak,
									"concurrency": curConcurrency,
								})
							} else {
								warnMu.Unlock()
							}
						}
					}
				}
			}
		}()

		if settings.LocalSteadyMBps > 0 {
			effBytes := tester.ResolveEffectiveMaxBytes(settings)
			job.pushLog(fmt.Sprintf("[采样保护] 已参考本地稳态带宽 %.1f MB/s，单节点精测流量上限自适应为 %.0f MB（保证稳态采样窗口）", settings.LocalSteadyMBps, float64(effBytes)/(1024*1024)))
		}

		rawResults := tester.RunConcurrentSpeedTestsWithController(ctx, nodes, inst, workerPorts, settings, limiter, ctrl, func(index, total int, res tester.NodeResult) {
			elapsedNow := time.Since(startedAt).Milliseconds()
			job.mu.Lock()
			job.completed = index
			job.totalBytes += res.TotalBytes
			job.elapsedMs = elapsedNow
			totalBytesNow := job.totalBytes
			job.results = append(job.results, res)
			job.mu.Unlock()

			var msg string
			if res.LatencyMs == nil {
				msg = fmt.Sprintf("[%d/%d] %s -> %s", index, total, res.Name, res.Status)
			} else if res.Status != "OK" {
				msg = fmt.Sprintf("[%d/%d] %s -> 延迟 %dms | 失败 (%s)", index, total, res.Name, *res.LatencyMs, res.Error)
			} else {
				msg = fmt.Sprintf("[%d/%d] %s -> 延迟 %dms | 均速 %.2f MB/s | 稳态 %.2f MB/s | 质量分 %.2f", index, total, res.Name, *res.LatencyMs, res.AvgSpeedMBps, res.SteadySpeedMBps, res.ValueScore)
			}
			job.pushLog(msg)
			job.broadcast("progress", map[string]any{
				"index":      index,
				"total":      total,
				"result":     res,
				"totalBytes": totalBytesNow,
				"elapsedMs":  elapsedNow,
			})
		})

		sorted := report.SortResults(rawResults, sortBy)
		finalElapsedMs := time.Since(startedAt).Milliseconds()
		job.mu.Lock()
		job.results = sorted
		job.elapsedMs = finalElapsedMs
		finalTotalBytes := job.totalBytes
		job.mu.Unlock()

		if err := report.SaveSpeedRank(sorted, outputPath, sortBy, finalElapsedMs); err != nil {
			job.pushLog("保存结果失败: " + err.Error())
		}

		aborted := ctx.Err() != nil
		if aborted {
			job.pushLog(fmt.Sprintf("测速已手动中止，已保存当前 %d 个节点的结果。", len(sorted)))
		} else {
			job.pushLog(fmt.Sprintf("全部测速完成！共消耗 %.2f MB 流量，耗时 %.1f 秒，结果已保存至 results/speed-rank.json", float64(finalTotalBytes)/(1024*1024), float64(finalElapsedMs)/1000))
		}
		job.broadcast("done", map[string]any{
			"aborted":    aborted,
			"results":    sorted,
			"totalBytes": finalTotalBytes,
			"elapsedMs":  finalElapsedMs,
		})
	}

	distFS, _ := fs.Sub(embeddedDist, "web/dist")
	mux := http.NewServeMux()

	mux.HandleFunc("/api/settings", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			s, _, err := config.LoadSettings(settingsPath)
			if err != nil {
				sendJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
				return
			}
			sendJSON(w, http.StatusOK, map[string]any{"settings": s})
		case http.MethodPut:
			cur, _, err := config.LoadSettings(settingsPath)
			if err != nil {
				sendJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
				return
			}
			if err := json.NewDecoder(r.Body).Decode(&cur); err != nil {
				sendJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			if err := config.SaveSettings(settingsPath, cur); err != nil {
				sendJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
				return
			}
			sendJSON(w, http.StatusOK, map[string]any{"settings": cur})
		default:
			sendJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method Not Allowed"})
		}
	})

	mux.HandleFunc("/api/results", func(w http.ResponseWriter, r *http.Request) {
		job.mu.Lock()
		isRunning := job.running
		resCopy := append([]tester.NodeResult(nil), job.results...)
		sb := job.sortBy
		tb := job.totalBytes
		startedAtMs := job.startedAtMs
		el := job.elapsedMs
		job.mu.Unlock()

		if isRunning && len(resCopy) > 0 {
			sendJSON(w, http.StatusOK, map[string]any{
				"running": true, "results": resCopy, "sortBy": sb,
				"totalBytes": tb, "startedAtMs": startedAtMs, "elapsedMs": el,
			})
			return
		}
		b, err := os.ReadFile(outputPath)
		if err != nil {
			sendJSON(w, http.StatusOK, map[string]any{
				"running": false, "results": []any{}, "totalNodes": 0, "okNodes": 0, "totalBytes": 0, "elapsedMs": 0,
			})
			return
		}
		var payload map[string]any
		if err := json.Unmarshal(b, &payload); err != nil {
			sendJSON(w, http.StatusOK, map[string]any{
				"running": false, "results": []any{}, "totalNodes": 0, "okNodes": 0, "totalBytes": 0, "elapsedMs": 0,
			})
			return
		}
		payload["running"] = false
		sendJSON(w, http.StatusOK, payload)
	})

	mux.HandleFunc("/api/history", func(w http.ResponseWriter, r *http.Request) {
		items := report.ListHistorySnapshots(historyDir)
		sendJSON(w, http.StatusOK, map[string]any{"history": items})
	})

	mux.HandleFunc("/api/history/node", func(w http.ResponseWriter, r *http.Request) {
		nodeName := r.URL.Query().Get("name")
		if nodeName == "" {
			sendJSON(w, http.StatusBadRequest, map[string]string{"error": "缺少 name 参数"})
			return
		}
		snapshots := report.ListHistorySnapshots(historyDir)
		if len(snapshots) > 15 {
			snapshots = snapshots[:15]
		}
		records := make([]map[string]any, 0)
		for _, snap := range snapshots {
			full, err := report.LoadHistorySnapshot(historyDir, snap.ID)
			if err != nil {
				continue
			}
			for _, item := range full.Results {
				if item.Name == nodeName {
					records = append(records, map[string]any{
						"id":              snap.ID,
						"generatedAt":     snap.GeneratedAt,
						"name":            item.Name,
						"type":            item.Type,
						"multiplier":      item.Multiplier,
						"status":          item.Status,
						"latencyMs":       item.LatencyMs,
						"totalBytes":      item.TotalBytes,
						"avgSpeedMBps":    item.AvgSpeedMBps,
						"steadySpeedMBps": item.SteadySpeedMBps,
						"valueScore":      item.ValueScore,
						"error":           item.Error,
					})
					break
				}
			}
		}
		sendJSON(w, http.StatusOK, map[string]any{"nodeName": nodeName, "records": records})
	})

	mux.HandleFunc("/api/history/", func(w http.ResponseWriter, r *http.Request) {
		id := strings.TrimPrefix(r.URL.Path, "/api/history/")
		snap, err := report.LoadHistorySnapshot(historyDir, id)
		if err != nil {
			sendJSON(w, http.StatusNotFound, map[string]string{"error": "未找到对应的历史记录"})
			return
		}
		sendJSON(w, http.StatusOK, snap)
	})

	mux.HandleFunc("/api/speedtest/stream", func(w http.ResponseWriter, r *http.Request) {
		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "Streaming unsupported", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")

		ch := make(sseClient, 64)
		job.mu.Lock()
		job.clients[ch] = struct{}{}
		initData, _ := json.Marshal(map[string]any{
			"running":     job.running,
			"stage":       job.stage,
			"total":       job.total,
			"completed":   job.completed,
			"sortBy":      job.sortBy,
			"startedAtMs": job.startedAtMs,
			"elapsedMs":   job.elapsedMs,
			"totalBytes":  job.totalBytes,
			"results":     job.results,
			"logs":        job.logs,
		})
		job.mu.Unlock()

		_, _ = fmt.Fprintf(w, "event: init\ndata: %s\n\n", string(initData))
		flusher.Flush()

		defer func() {
			job.mu.Lock()
			delete(job.clients, ch)
			job.mu.Unlock()
		}()

		for {
			select {
			case <-r.Context().Done():
				return
			case msg := <-ch:
				_, _ = fmt.Fprint(w, msg)
				flusher.Flush()
			}
		}
	})

	mux.HandleFunc("/api/speedtest/start", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			sendJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method Not Allowed"})
			return
		}
		job.mu.Lock()
		isRunning := job.running
		job.mu.Unlock()
		if isRunning {
			sendJSON(w, http.StatusConflict, map[string]string{"error": "已有测速任务正在运行中"})
			return
		}

		var body struct {
			SubscribeURL      string   `json:"subscribeUrl"`
			SortBy            string   `json:"sortBy"`
			Limit             int      `json:"limit"`
			SelectedNodes     []string `json:"selectedNodes"`
			EnableUnlockCheck *bool    `json:"enableUnlockCheck"`
			Concurrency       *int     `json:"concurrency"`
			MaxBandwidthMBps  *float64 `json:"maxBandwidthMBps"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if strings.TrimSpace(body.SubscribeURL) != "" {
			cur, _, _ := config.LoadSettings(settingsPath)
			cur.SubscribeURL = strings.TrimSpace(body.SubscribeURL)
			_ = config.SaveSettings(settingsPath, cur)
		}
		sortBy := body.SortBy
		if sortBy != "steady" && sortBy != "value" {
			sortBy = "avg"
		}
		go runJob(sortBy, body.Limit, body.SelectedNodes, body.EnableUnlockCheck, body.Concurrency, body.MaxBandwidthMBps)
		sendJSON(w, http.StatusAccepted, map[string]any{"started": true, "sortBy": sortBy, "limit": body.Limit})
	})

	mux.HandleFunc("/api/speedtest/concurrency", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			sendJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method Not Allowed"})
			return
		}
		var body struct {
			Concurrency int `json:"concurrency"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			sendJSON(w, http.StatusBadRequest, map[string]string{"error": "无效的请求体"})
			return
		}
		next := body.Concurrency
		if next < 1 {
			next = 1
		}
		if next > 16 {
			next = 16
		}
		if cur, _, err := config.LoadSettings(settingsPath); err == nil {
			if next > 1 && cur.MaxBandwidthMBps <= 0 {
				sendJSON(w, http.StatusBadRequest, map[string]string{"error": "请先设置宽带上限（或点击「测上限」自动获取）后再开启多线程"})
				return
			}
			cur.Concurrency = next
			_ = config.SaveSettings(settingsPath, cur)
		}
		job.mu.Lock()
		isRunning := job.running
		scaleFn := job.scaleFn
		job.mu.Unlock()
		applied := next
		changed := false
		if isRunning && scaleFn != nil {
			applied, changed = scaleFn(next)
		}
		sendJSON(w, http.StatusOK, map[string]any{
			"ok":          true,
			"running":     isRunning,
			"concurrency": applied,
			"appliedNow":  isRunning && scaleFn != nil,
			"changed":     changed,
		})
	})

	mux.HandleFunc("/api/bandwidth/test", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			sendJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method Not Allowed"})
			return
		}
		job.mu.Lock()
		isRunning := job.running
		job.mu.Unlock()
		if isRunning {
			sendJSON(w, http.StatusConflict, map[string]string{"error": "节点测速进行中，请先停止后再测宽带上限"})
			return
		}
		var body struct {
			Mode      string `json:"mode"`
			CustomURL string `json:"customUrl"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		settings, _, _ := config.LoadSettings(settingsPath)
		ctx, cancel := context.WithTimeout(r.Context(), 13*time.Second)
		defer cancel()
		res, err := tester.TestLocalBandwidth(ctx, body.Mode, settings.TestURL, body.CustomURL)
		if err != nil {
			sendJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
			return
		}
		if res.SteadyMBps > 0 {
			settings.LocalSteadyMBps = res.SteadyMBps
			_ = config.SaveSettings(settingsPath, settings)
		}
		sendJSON(w, http.StatusOK, map[string]any{
			"ok":              true,
			"mode":            res.Mode,
			"usedUrl":         res.UsedURL,
			"usedUrls":        res.UsedURLs,
			"peakMBps":        res.PeakMBps,
			"steadyMBps":      res.SteadyMBps,
			"peakMbps":        res.PeakMbps,
			"recommendedMBps": res.RecommendedMBps,
			"totalBytes":      res.TotalBytes,
			"durationMs":      res.DurationMs,
		})
	})

	mux.HandleFunc("/api/speedtest/preview", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			sendJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method Not Allowed"})
			return
		}
		job.mu.Lock()
		isRunning := job.running
		job.mu.Unlock()
		if isRunning {
			sendJSON(w, http.StatusConflict, map[string]string{"error": "测速进行中，请先停止后再预览"})
			return
		}
		settings, _, err := config.LoadSettings(settingsPath)
		if err != nil {
			sendJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		var body struct {
			SubscribeURL string `json:"subscribeUrl"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if strings.TrimSpace(body.SubscribeURL) != "" {
			settings.SubscribeURL = strings.TrimSpace(body.SubscribeURL)
		}

		mixedPort, controllerPort, err := preflight.ResolvePorts(settings.MixedPort, settings.ControllerPort)
		if err != nil {
			sendJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		binPath, err := preflight.EnsureMihomoBinary(binDir)
		if err != nil {
			sendJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		subInfo, err := subscribe.PrepareRuntimeSubscription(settings, mixedPort, controllerPort, configsDir)
		if err != nil {
			sendJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		inst, err := mihomo.StartProcess(binPath, configsDir, subInfo.RuntimeYAMLPath, controllerPort, settings.ControllerSecret, subInfo.HasProviders)
		if err != nil {
			sendJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		defer inst.Stop()

		nodes, err := inst.FetchFilteredProxies(settings.ExcludeKeywords, settings.IncludeRegions, settings.IncludeKeywords, settings.RegionKeywords)
		if err != nil {
			sendJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		items := make([]map[string]any, 0, len(nodes))
		for _, n := range nodes {
			items = append(items, map[string]any{
				"name":       n.Name,
				"type":       n.Type,
				"multiplier": n.Multiplier,
			})
		}
		sendJSON(w, http.StatusOK, map[string]any{
			"totalNodes": len(items),
			"nodes":      items,
		})
	})

	mux.HandleFunc("/api/speedtest/retest", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			sendJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method Not Allowed"})
			return
		}
		job.mu.Lock()
		isRunning := job.running
		job.mu.Unlock()
		if isRunning {
			sendJSON(w, http.StatusConflict, map[string]string{"error": "已有测速任务正在运行中，请先停止后再单点复测"})
			return
		}
		var body struct {
			NodeName          string `json:"nodeName"`
			SortBy            string `json:"sortBy"`
			EnableUnlockCheck *bool  `json:"enableUnlockCheck"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.NodeName) == "" {
			sendJSON(w, http.StatusBadRequest, map[string]string{"error": "缺少有效的 nodeName 参数"})
			return
		}
		settings, _, err := config.LoadSettings(settingsPath)
		if err != nil {
			sendJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		enableUnlock := settings.EnableUnlockCheck
		if body.EnableUnlockCheck != nil {
			enableUnlock = *body.EnableUnlockCheck
		}

		mixedPort, controllerPort, err := preflight.ResolvePorts(settings.MixedPort, settings.ControllerPort)
		if err != nil {
			sendJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		binPath, err := preflight.EnsureMihomoBinary(binDir)
		if err != nil {
			sendJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		subInfo, err := subscribe.PrepareRuntimeSubscription(settings, mixedPort, controllerPort, configsDir)
		if err != nil {
			sendJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		inst, err := mihomo.StartProcess(binPath, configsDir, subInfo.RuntimeYAMLPath, controllerPort, settings.ControllerSecret, subInfo.HasProviders)
		if err != nil {
			sendJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		defer inst.Stop()

		nodes, err := inst.FetchFilteredProxies(nil, nil, nil, nil)
		if err != nil {
			sendJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		var targetNode *mihomo.ProxyNode
		for i := range nodes {
			if nodes[i].Name == body.NodeName {
				targetNode = &nodes[i]
				break
			}
		}
		if targetNode == nil {
			sendJSON(w, http.StatusNotFound, map[string]string{"error": fmt.Sprintf("订阅中未找到节点「%s」", body.NodeName)})
			return
		}

		res := tester.TestSingleNode(r.Context(), *targetNode, inst, mixedPort, settings, enableUnlock)

		var existing report.SpeedRankPayload
		if raw, err := os.ReadFile(outputPath); err == nil {
			_ = json.Unmarshal(raw, &existing)
		}
		updatedList := make([]tester.NodeResult, 0, len(existing.Results)+1)
		replaced := false
		for _, item := range existing.Results {
			if item.Name == res.Name {
				updatedList = append(updatedList, res)
				replaced = true
			} else {
				updatedList = append(updatedList, item)
			}
		}
		if !replaced {
			updatedList = append(updatedList, res)
		}
		sortBy := body.SortBy
		if sortBy == "" {
			sortBy = existing.SortBy
		}
		if sortBy != "steady" && sortBy != "value" {
			sortBy = "avg"
		}
		sorted := report.SortResults(updatedList, sortBy)
		_ = report.SaveSpeedRankLatestOnly(sorted, outputPath, sortBy, existing.ElapsedMs)

		sendJSON(w, http.StatusOK, map[string]any{
			"result":  res,
			"results": sorted,
		})
	})

	mux.HandleFunc("/api/export/clash-yaml", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			sendJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method Not Allowed"})
			return
		}
		var body struct {
			TopN      int      `json:"topN"`
			NodeNames []string `json:"nodeNames"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		topN := body.TopN
		if topN <= 0 {
			topN = 10
		}

		names := body.NodeNames
		if len(names) == 0 {
			raw, err := os.ReadFile(outputPath)
			if err != nil {
				sendJSON(w, http.StatusBadRequest, map[string]string{"error": "暂无可用测速结果，请先运行测速"})
				return
			}
			var existing report.SpeedRankPayload
			if err := json.Unmarshal(raw, &existing); err != nil {
				sendJSON(w, http.StatusInternalServerError, map[string]string{"error": "读取测速结果失败"})
				return
			}
			for _, item := range existing.Results {
				if item.Status == "OK" && item.AvgSpeedMBps > 0 {
					names = append(names, item.Name)
					if len(names) >= topN {
						break
					}
				}
			}
		}

		runtimeYAML := filepath.Join(configsDir, "runtime.yaml")
		yamlStr, count, err := report.BuildOptimizedClashYAML(runtimeYAML, names)
		if err != nil {
			sendJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		sendJSON(w, http.StatusOK, map[string]any{
			"yaml":     yamlStr,
			"count":    count,
			"filename": fmt.Sprintf("mihomo-top%d.yaml", count),
		})
	})

	mux.HandleFunc("/api/speedtest/stop", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			sendJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method Not Allowed"})
			return
		}
		job.mu.Lock()
		isRunning := job.running
		job.mu.Unlock()
		if !isRunning {
			sendJSON(w, http.StatusOK, map[string]any{"stopped": false, "message": "当前没有运行中的测速任务"})
			return
		}
		job.stopActive()
		sendJSON(w, http.StatusOK, map[string]any{"stopped": true})
	})

	mux.HandleFunc("/api/preflight/vpn-check", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			sendJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method Not Allowed"})
			return
		}
		sendJSON(w, http.StatusOK, preflight.DetectRunningVPN())
	})

	mux.HandleFunc("/api/preflight/vpn-shutdown", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			sendJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method Not Allowed"})
			return
		}
		job.mu.Lock()
		isRunning := job.running
		job.mu.Unlock()
		if isRunning {
			sendJSON(w, http.StatusConflict, map[string]string{"error": "测速任务正在运行中"})
			return
		}
		closed, err := preflight.ShutdownSupportedVPNs()
		if err != nil {
			sendJSON(w, http.StatusForbidden, map[string]string{"error": err.Error()})
			return
		}
		sendJSON(w, http.StatusOK, map[string]any{
			"ok":     true,
			"closed": closed,
		})
	})

	mux.HandleFunc("/api/preflight/vpn-launch", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			sendJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method Not Allowed"})
			return
		}
		var body struct {
			ExePath string `json:"exePath"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			sendJSON(w, http.StatusBadRequest, map[string]string{"error": "无效的请求体"})
			return
		}
		if err := preflight.LaunchVPNByPath(body.ExePath); err != nil {
			sendJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		sendJSON(w, http.StatusOK, map[string]any{"ok": true})
	})

	mux.HandleFunc("/api/vpn/probe", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			sendJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method Not Allowed"})
			return
		}
		var body struct {
			APIURL   string `json:"apiUrl"`
			Secret   string `json:"secret"`
			NodeName string `json:"nodeName"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		cur, _, _ := config.LoadSettings(settingsPath)
		apiURL := strings.TrimSpace(body.APIURL)
		if apiURL == "" {
			apiURL = cur.ClashVergeAPI
		}
		secret := body.Secret
		if secret == "" && apiURL == cur.ClashVergeAPI {
			secret = cur.ClashVergeSecret
		}
		sendJSON(w, http.StatusOK, vpn.ProbeController(apiURL, secret, body.NodeName))
	})

	mux.HandleFunc("/api/vpn/apply", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			sendJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method Not Allowed"})
			return
		}
		var body struct {
			APIURL   string `json:"apiUrl"`
			Secret   string `json:"secret"`
			Selector string `json:"selector"`
			NodeName string `json:"nodeName"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			sendJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		cur, _, _ := config.LoadSettings(settingsPath)
		apiURL := strings.TrimSpace(body.APIURL)
		if apiURL == "" {
			apiURL = cur.ClashVergeAPI
		}
		secret := body.Secret
		if secret == "" && apiURL == cur.ClashVergeAPI {
			secret = cur.ClashVergeSecret
		}
		selector := strings.TrimSpace(body.Selector)
		if selector == "" {
			selector = cur.ClashVergeSelector
		}
		res, err := vpn.ApplyNode(apiURL, secret, selector, body.NodeName)
		if err != nil {
			sendJSON(w, http.StatusBadRequest, map[string]any{"applied": false, "error": err.Error()})
			return
		}
		sendJSON(w, http.StatusOK, res)
	})

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			sendJSON(w, http.StatusNotFound, map[string]string{"error": "Not Found"})
			return
		}
		rel := strings.TrimPrefix(r.URL.Path, "/")
		if rel == "" {
			rel = "index.html"
		}
		content, err := fs.ReadFile(distFS, rel)
		if err != nil {
			rel = "index.html"
			content, err = fs.ReadFile(distFS, rel)
			if err != nil {
				http.Error(w, "Not Found", http.StatusNotFound)
				return
			}
		}
		if ct := mime.TypeByExtension(filepath.Ext(rel)); ct != "" {
			w.Header().Set("Content-Type", ct)
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(content)
	})

	port, err := preflight.FindAvailablePort(*portFlag, nil)
	if err != nil {
		fmt.Fprintf(os.Stderr, "端口探测失败: %v\n", err)
		os.Exit(1)
	}
	addr := fmt.Sprintf("%s:%d", *hostFlag, port)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		fmt.Fprintf(os.Stderr, "监听端口失败 (%s): %v\n", addr, err)
		os.Exit(1)
	}

	displayHost := *hostFlag
	if displayHost == "0.0.0.0" {
		displayHost = "127.0.0.1"
	}
	urlStr := fmt.Sprintf("http://%s:%d", displayHost, port)
	fmt.Printf("Mihomo Speedtest (Go 版) 已启动: %s\n", urlStr)
	fmt.Println("按 Ctrl+C 退出程序。")

	if !*noOpen {
		openBrowser(urlStr)
	}

	srv := &http.Server{Handler: mux}
	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
		<-sigCh
		fmt.Println("\n正在安全清理 Mihomo 内核并退出...")
		job.stopActive()
		_ = srv.Close()
	}()

	if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
		fmt.Fprintf(os.Stderr, "HTTP 服务异常退出: %v\n", err)
		os.Exit(1)
	}
}
