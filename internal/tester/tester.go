package tester

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"sync"
	"sync/atomic"
	"time"

	"mihomo-speedtest/internal/config"
	"mihomo-speedtest/internal/mihomo"
)

const (
	steadyWarmupMs       = 1500
	minValidBytesOnAbort = 512 * 1024
)

type NodeResult struct {
	Name            string  `json:"name"`
	Type            string  `json:"type"`
	Multiplier      float64 `json:"multiplier"`
	Status          string  `json:"status"`
	LatencyMs       *int    `json:"latencyMs"`
	TotalBytes      int64   `json:"totalBytes"`
	DurationMs      int64   `json:"durationMs"`
	AvgSpeedMBps    float64 `json:"avgSpeedMBps"`
	SteadySpeedMBps float64 `json:"steadySpeedMBps"`
	ValueScore      float64     `json:"valueScore"`
	Error           string      `json:"error,omitempty"`
	Unlock          *UnlockInfo `json:"unlock,omitempty"`
}

func round2(v float64) float64 {
	return math.Round(v*100) / 100
}

func SwitchProxyGroup(inst *mihomo.Instance, groupName, nodeName string) error {
	body, _ := json.Marshal(map[string]string{"name": nodeName})
	apiPath := fmt.Sprintf("/proxies/%s", url.PathEscape(groupName))
	resp, err := inst.ControllerRequest(http.MethodPut, apiPath, bytes.NewReader(body))
	if err != nil {
		return err
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusOK {
		return fmt.Errorf("切换 %s 节点失败 (%s): HTTP %d", groupName, nodeName, resp.StatusCode)
	}
	return nil
}

func SwitchGlobalProxy(inst *mihomo.Instance, nodeName string) error {
	return SwitchProxyGroup(inst, "GLOBAL", nodeName)
}

func TestNodeLatency(inst *mihomo.Instance, nodeName string, latencyTimeoutMs int) *int {
	escaped := url.PathEscape(nodeName)
	target := url.QueryEscape("http://www.gstatic.com/generate_204")
	apiPath := fmt.Sprintf("/proxies/%s/delay?timeout=%d&url=%s", escaped, latencyTimeoutMs, target)
	resp, err := inst.ControllerRequest(http.MethodGet, apiPath, nil)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil
	}
	var payload struct {
		Delay int `json:"delay"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil || payload.Delay < 0 {
		return nil
	}
	return &payload.Delay
}

func computeMetrics(totalBytes, steadyBytes int64, startTime time.Time, steadyStartTime *time.Time, endTime time.Time, multiplier float64) (float64, float64, float64) {
	elapsedMs := endTime.Sub(startTime).Milliseconds()
	if elapsedMs < 1 {
		elapsedMs = 1
	}
	elapsedSec := float64(elapsedMs) / 1000.0
	avgSpeed := float64(totalBytes) / (1024 * 1024) / elapsedSec

	steadySpeed := avgSpeed
	if elapsedMs >= 2000 && steadyStartTime != nil && steadyBytes > 0 {
		steadySec := endTime.Sub(*steadyStartTime).Seconds()
		if steadySec < 0.001 {
			steadySec = 0.001
		}
		steadySpeed = float64(steadyBytes) / (1024 * 1024) / steadySec
	}

	mult := multiplier
	if mult <= 0 {
		mult = 1.0
	}
	valueScore := avgSpeed / mult
	return round2(avgSpeed), round2(steadySpeed), round2(valueScore)
}

func RunStreamDownloadTest(parentCtx context.Context, mixedPort int, testURL string, maxBytesPerNode int64, downloadTimeoutMs int, multiplier float64) (bool, int64, float64, float64, float64, string) {
	return runStreamDownloadTestWithLimiter(parentCtx, mixedPort, testURL, maxBytesPerNode, downloadTimeoutMs, multiplier, nil)
}

func runStreamDownloadTestWithLimiter(parentCtx context.Context, mixedPort int, testURL string, maxBytesPerNode int64, downloadTimeoutMs int, multiplier float64, limiter *BandwidthLimiter) (bool, int64, float64, float64, float64, string) {
	proxyURL, _ := url.Parse(fmt.Sprintf("http://127.0.0.1:%d", mixedPort))
	transport := &http.Transport{
		Proxy:               http.ProxyURL(proxyURL),
		DisableKeepAlives:   true,
		TLSHandshakeTimeout: 5 * time.Second,
	}
	defer transport.CloseIdleConnections()

	ctx, cancel := context.WithTimeout(parentCtx, time.Duration(downloadTimeoutMs)*time.Millisecond)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, testURL, nil)
	if err != nil {
		return false, 0, 0, 0, 0, err.Error()
	}

	client := &http.Client{Transport: transport}
	resp, err := client.Do(req)
	if err != nil {
		return false, 0, 0, 0, 0, err.Error()
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return false, 0, 0, 0, 0, fmt.Sprintf("HTTP %d", resp.StatusCode)
	}

	startTime := time.Now()
	var totalBytes int64
	var steadyBytes int64
	var steadyStartTime *time.Time
	var abortedByCap bool
	var streamCompleted bool
	var caughtErr error

	buf := make([]byte, 32*1024)
	for {
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			if limiter != nil {
				if limErr := limiter.Consume(ctx, n); limErr != nil {
					caughtErr = limErr
					break
				}
			}
			now := time.Now()
			totalBytes += int64(n)
			if now.Sub(startTime).Milliseconds() >= steadyWarmupMs {
				if steadyStartTime == nil {
					t := now
					steadyStartTime = &t
				}
				steadyBytes += int64(n)
			}
			if totalBytes >= maxBytesPerNode {
				abortedByCap = true
				cancel()
				break
			}
		}
		if readErr != nil {
			if readErr == io.EOF {
				streamCompleted = true
			} else {
				caughtErr = readErr
			}
			break
		}
	}

	endTime := time.Now()
	hasValidPartial := totalBytes > minValidBytesOnAbort
	if abortedByCap || streamCompleted || hasValidPartial {
		avg, steady, val := computeMetrics(totalBytes, steadyBytes, startTime, steadyStartTime, endTime, multiplier)
		errMsg := ""
		if caughtErr != nil && !abortedByCap {
			errMsg = caughtErr.Error()
		}
		return true, totalBytes, avg, steady, val, errMsg
	}

	errMsg := "下载失败且数据不足 512KB"
	if caughtErr != nil {
		errMsg = caughtErr.Error()
	}
	return false, totalBytes, 0, 0, 0, errMsg
}

// TestSingleNode 对单个节点执行切换、延迟预筛、流式下载以及可选的落地与解锁探测。
func TestSingleNode(ctx context.Context, node mihomo.ProxyNode, inst *mihomo.Instance, mixedPort int, s config.Settings, enableUnlockCheck bool) NodeResult {
	return testSingleNodeWithTarget(ctx, node, inst, "GLOBAL", mixedPort, s, enableUnlockCheck, nil)
}

func testSingleNodeWithTarget(ctx context.Context, node mihomo.ProxyNode, inst *mihomo.Instance, proxyGroup string, mixedPort int, s config.Settings, enableUnlockCheck bool, limiter *BandwidthLimiter) NodeResult {
	nodeStart := time.Now()
	var record NodeResult

	if err := SwitchProxyGroup(inst, proxyGroup, node.Name); err != nil {
		record = NodeResult{
			Name:       node.Name,
			Type:       node.Type,
			Multiplier: node.Multiplier,
			Status:     "Error",
			Error:      err.Error(),
		}
	} else {
		lat := TestNodeLatency(inst, node.Name, s.LatencyTimeoutMs)
		if lat == nil {
			record = NodeResult{
				Name:       node.Name,
				Type:       node.Type,
				Multiplier: node.Multiplier,
				Status:     "Dead / Timeout",
			}
		} else {
			ok, totalBytes, avg, steady, val, errMsg := runStreamDownloadTestWithLimiter(
				ctx,
				mixedPort,
				s.TestURL,
				s.MaxBytesPerNode,
				s.DownloadTimeoutMs,
				node.Multiplier,
				limiter,
			)
			status := "OK"
			if !ok {
				status = "Download Failed"
			}
			var unlock *UnlockInfo
			if ok && enableUnlockCheck && ctx.Err() == nil {
				unlock = ProbeNodeUnlock(ctx, mixedPort)
			}
			record = NodeResult{
				Name:            node.Name,
				Type:            node.Type,
				Multiplier:      node.Multiplier,
				Status:          status,
				LatencyMs:       lat,
				TotalBytes:      totalBytes,
				AvgSpeedMBps:    avg,
				SteadySpeedMBps: steady,
				ValueScore:      val,
				Error:           errMsg,
				Unlock:          unlock,
			}
		}
	}

	record.DurationMs = time.Since(nodeStart).Milliseconds()
	return record
}

func RunSerialSpeedTests(ctx context.Context, nodes []mihomo.ProxyNode, inst *mihomo.Instance, mixedPort int, s config.Settings, onProgress func(index, total int, res NodeResult)) []NodeResult {
	return RunConcurrentSpeedTests(ctx, nodes, inst, []int{mixedPort}, s, nil, onProgress)
}

// ConcurrencyController 支持在测速运行期间安全地动态调整并发 Worker 数量（热扩容 / 热缩容）。
type ConcurrencyController struct {
	mu               sync.Mutex
	target           int
	max              int
	spawnFn          func(newTarget int)
	OnCongestedRetry func(nodeName string, attempt int)
}

func NewConcurrencyController(initial, max int) *ConcurrencyController {
	if max < 1 {
		max = 1
	}
	if initial < 1 {
		initial = 1
	}
	if initial > max {
		initial = max
	}
	return &ConcurrencyController{target: initial, max: max}
}

func (c *ConcurrencyController) Target() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.target
}

func (c *ConcurrencyController) SetTarget(n int) int {
	c.mu.Lock()
	if n < 1 {
		n = 1
	}
	if n > c.max {
		n = c.max
	}
	c.target = n
	fn := c.spawnFn
	c.mu.Unlock()
	if fn != nil {
		fn(n)
	}
	return n
}

// RunConcurrentSpeedTests 支持单线程或多线程（独立 Worker 端口 + 策略组 + 令牌桶限速）并发测速。
func RunConcurrentSpeedTests(ctx context.Context, nodes []mihomo.ProxyNode, inst *mihomo.Instance, workerPorts []int, s config.Settings, limiter *BandwidthLimiter, onProgress func(index, total int, res NodeResult)) []NodeResult {
	return RunConcurrentSpeedTestsWithController(ctx, nodes, inst, workerPorts, s, limiter, nil, onProgress)
}

// RunConcurrentSpeedTestsWithController 支持在多端口预挂载模式下动态热调整并发线程数。
func RunConcurrentSpeedTestsWithController(ctx context.Context, nodes []mihomo.ProxyNode, inst *mihomo.Instance, workerPorts []int, s config.Settings, limiter *BandwidthLimiter, ctrl *ConcurrencyController, onProgress func(index, total int, res NodeResult)) []NodeResult {
	total := len(nodes)
	if total == 0 {
		return []NodeResult{}
	}
	if len(workerPorts) <= 1 {
		port := s.MixedPort
		if len(workerPorts) == 1 {
			port = workerPorts[0]
		}
		results := make([]NodeResult, 0, total)
		for i, node := range nodes {
			if ctx.Err() != nil {
				break
			}
			record := testSingleNodeWithTarget(ctx, node, inst, "GLOBAL", port, s, s.EnableUnlockCheck, limiter)
			results = append(results, record)
			if onProgress != nil {
				onProgress(i+1, total, record)
			}
		}
		return results
	}

	maxWorkers := len(workerPorts)
	if ctrl == nil {
		ctrl = NewConcurrencyController(maxWorkers, maxWorkers)
	}

	type taskItem struct {
		node    mihomo.ProxyNode
		retries int
	}
	var qMu sync.Mutex
	qCond := sync.NewCond(&qMu)
	queue := make([]taskItem, 0, total)
	for _, n := range nodes {
		queue = append(queue, taskItem{node: n, retries: 0})
	}
	inFlight := 0

	var mu sync.Mutex
	var completedCount atomic.Int32
	results := make([]NodeResult, 0, total)
	var wg sync.WaitGroup

	var slotMu sync.Mutex
	activeSlots := make([]bool, maxWorkers)

	var spawnWorkers func(target int)
	spawnWorkers = func(target int) {
		if target > maxWorkers {
			target = maxWorkers
		}
		slotMu.Lock()
		defer slotMu.Unlock()
		for w := 0; w < target; w++ {
			if activeSlots[w] {
				continue
			}
			activeSlots[w] = true
			workerPort := workerPorts[w]
			workerGroup := fmt.Sprintf("SPEEDTEST_W%d", w)
			wg.Add(1)
			go func(slot int, port int, group string) {
				defer func() {
					slotMu.Lock()
					activeSlots[slot] = false
					slotMu.Unlock()
					wg.Done()
				}()
				for {
					if ctx.Err() != nil || slot >= ctrl.Target() {
						return
					}
					qMu.Lock()
					for len(queue) == 0 && inFlight > 0 && ctx.Err() == nil && slot < ctrl.Target() {
						qCond.Wait()
					}
					if ctx.Err() != nil || slot >= ctrl.Target() || (len(queue) == 0 && inFlight == 0) {
						qMu.Unlock()
						return
					}
					item := queue[0]
					queue = queue[1:]
					inFlight++
					qMu.Unlock()

					nodeStart := time.Now()
					record := testSingleNodeWithTarget(ctx, item.node, inst, group, port, s, s.EnableUnlockCheck, limiter)
					nodeEnd := time.Now()

					if ctx.Err() != nil && record.Status == "Error" {
						qMu.Lock()
						inFlight--
						qCond.Broadcast()
						qMu.Unlock()
						return
					}

					// 若测速期间总宽带发生封顶，且当前仍有多线程并发，则放弃本次受限结果，放回队列等降线程后重测
					if record.Status == "OK" && ctrl.Target() > 1 && limiter != nil && limiter.WasCongestedBetween(nodeStart, nodeEnd) && item.retries < 2 {
						qMu.Lock()
						inFlight--
						queue = append(queue, taskItem{node: item.node, retries: item.retries + 1})
						qCond.Broadcast()
						qMu.Unlock()
						if ctrl.OnCongestedRetry != nil {
							ctrl.OnCongestedRetry(item.node.Name, item.retries+1)
						}
						continue
					}

					qMu.Lock()
					inFlight--
					qCond.Broadcast()
					qMu.Unlock()

					mu.Lock()
					results = append(results, record)
					idx := int(completedCount.Add(1))
					mu.Unlock()
					if onProgress != nil {
						onProgress(idx, total, record)
					}
				}
			}(w, workerPort, workerGroup)
		}
	}

	ctrl.mu.Lock()
	ctrl.max = maxWorkers
	if ctrl.target > maxWorkers {
		ctrl.target = maxWorkers
	}
	ctrl.spawnFn = spawnWorkers
	initialTarget := ctrl.target
	ctrl.mu.Unlock()

	spawnWorkers(initialTarget)
	wg.Wait()

	ctrl.mu.Lock()
	ctrl.spawnFn = nil
	ctrl.mu.Unlock()

	return results
}
