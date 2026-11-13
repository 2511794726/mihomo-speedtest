package main

import (
	"context"
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"io/fs"
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
	results      []tester.NodeResult
	logs         []string
	cancel       context.CancelFunc
	activeMihomo *mihomo.Instance
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

	runJob := func(sortBy string, limit int) {
		ctx, cancel := context.WithCancel(context.Background())

		job.mu.Lock()
		job.running = true
		job.stage = "preflight"
		job.total = 0
		job.completed = 0
		job.sortBy = sortBy
		job.results = []tester.NodeResult{}
		job.logs = []string{}
		job.cancel = cancel
		job.mu.Unlock()

		job.broadcast("state", map[string]any{
			"running": true, "stage": "preflight", "total": 0, "completed": 0, "sortBy": sortBy,
		})

		defer func() {
			cancel()
			job.mu.Lock()
			job.running = false
			job.stage = "idle"
			job.cancel = nil
			job.activeMihomo = nil
			tot := job.total
			comp := job.completed
			sb := job.sortBy
			job.mu.Unlock()
			job.broadcast("state", map[string]any{
				"running": false, "stage": "idle", "total": tot, "completed": comp, "sortBy": sb,
			})
		}()

		settings, _, err := config.LoadSettings(settingsPath)
		if err != nil {
			job.pushLog("读取配置失败: " + err.Error())
			job.broadcast("error", map[string]string{"message": err.Error()})
			return
		}

		job.pushLog("正在预检端口与 Mihomo 内核...")
		mixedPort, controllerPort, err := preflight.ResolvePorts(settings.MixedPort, settings.ControllerPort)
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
		job.pushLog(fmt.Sprintf("内核就绪: %s (mixedPort=%d, controllerPort=%d)", binPath, mixedPort, controllerPort))

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

		subInfo, err := subscribe.PrepareRuntimeSubscription(settings, mixedPort, controllerPort, configsDir)
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
		if limit > 0 && len(nodes) > limit {
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
		})

		rawResults := tester.RunSerialSpeedTests(ctx, nodes, inst, mixedPort, settings, func(index, total int, res tester.NodeResult) {
			job.mu.Lock()
			job.completed = index
			job.results = append(job.results, res)
			job.mu.Unlock()

			var msg string
			if res.LatencyMs == nil {
				msg = fmt.Sprintf("[%d/%d] %s -> %s", index, total, res.Name, res.Status)
			} else if res.Status != "OK" {
				msg = fmt.Sprintf("[%d/%d] %s -> 延迟 %dms | 失败 (%s)", index, total, res.Name, *res.LatencyMs, res.Error)
			} else {
				msg = fmt.Sprintf("[%d/%d] %s -> 延迟 %dms | 均速 %.2f MB/s | 稳态 %.2f MB/s", index, total, res.Name, *res.LatencyMs, res.AvgSpeedMBps, res.SteadySpeedMBps)
			}
			job.pushLog(msg)
			job.broadcast("progress", map[string]any{
				"index":  index,
				"total":  total,
				"result": res,
			})
		})

		sorted := report.SortResults(rawResults, sortBy)
		job.mu.Lock()
		job.results = sorted
		job.mu.Unlock()

		if err := report.SaveSpeedRank(sorted, outputPath, sortBy); err != nil {
			job.pushLog("保存结果失败: " + err.Error())
		}

		aborted := ctx.Err() != nil
		if aborted {
			job.pushLog(fmt.Sprintf("测速已手动中止，已保存当前 %d 个节点的结果。", len(sorted)))
		} else {
			job.pushLog("全部测速完成！结果已保存至 results/speed-rank.json")
		}
		job.broadcast("done", map[string]any{
			"aborted": aborted,
			"results": sorted,
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
		job.mu.Unlock()

		if isRunning && len(resCopy) > 0 {
			sendJSON(w, http.StatusOK, map[string]any{
				"running": true, "results": resCopy, "sortBy": sb,
			})
			return
		}
		b, err := os.ReadFile(outputPath)
		if err != nil {
			sendJSON(w, http.StatusOK, map[string]any{
				"running": false, "results": []any{}, "totalNodes": 0, "okNodes": 0,
			})
			return
		}
		var payload map[string]any
		if err := json.Unmarshal(b, &payload); err != nil {
			sendJSON(w, http.StatusOK, map[string]any{
				"running": false, "results": []any{}, "totalNodes": 0, "okNodes": 0,
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
			"running":   job.running,
			"stage":     job.stage,
			"total":     job.total,
			"completed": job.completed,
			"sortBy":    job.sortBy,
			"results":   job.results,
			"logs":      job.logs,
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
			SubscribeURL string `json:"subscribeUrl"`
			SortBy       string `json:"sortBy"`
			Limit        int    `json:"limit"`
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
		go runJob(sortBy, body.Limit)
		sendJSON(w, http.StatusAccepted, map[string]any{"started": true, "sortBy": sortBy, "limit": body.Limit})
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
