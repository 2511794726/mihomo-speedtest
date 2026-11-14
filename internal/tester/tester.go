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
	"sort"
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
	Name            string      `json:"name"`
	Type            string      `json:"type"`
	Multiplier      float64     `json:"multiplier"`
	Status          string      `json:"status"`
	LatencyMs       *int        `json:"latencyMs"`
	JitterMs        *int        `json:"jitterMs,omitempty"`
	PacketLoss      *float64    `json:"packetLoss,omitempty"`
	TotalBytes      int64       `json:"totalBytes"`
	DurationMs      int64       `json:"durationMs"`
	AvgSpeedMBps    float64     `json:"avgSpeedMBps"`
	SteadySpeedMBps float64     `json:"steadySpeedMBps"`
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

// computeLatencyStats 从多轮延迟样本计算中位数延迟、平均相邻抖动(ms)和丢包率(%)。
func computeLatencyStats(samples []*int) (*int, *int, *float64) {
	if len(samples) == 0 {
		return nil, nil, nil
	}
	valid := make([]int, 0, len(samples))
	for _, s := range samples {
		if s != nil && *s >= 0 {
			valid = append(valid, *s)
		}
	}
	if len(valid) == 0 {
		loss := 100.0
		return nil, nil, &loss
	}

	sorted := make([]int, len(valid))
	copy(sorted, valid)
	sort.Ints(sorted)
	median := sorted[len(sorted)/2]

	jitter := 0
	if len(valid) >= 2 {
		sumDiff := 0
		for i := 1; i < len(valid); i++ {
			d := valid[i] - valid[i-1]
			if d < 0 {
				d = -d
			}
			sumDiff += d
		}
		jitter = int(math.Round(float64(sumDiff) / float64(len(valid)-1)))
	}

	failed := len(samples) - len(valid)
	loss := math.Round(float64(failed)/float64(len(samples))*1000) / 10
	return &median, &jitter, &loss
}

// TestNodeLatencyProfile 对节点进行最多 3 次轻量延迟采样，首轮失败即快速剪枝，首轮成功则计算抖动与丢包。
func TestNodeLatencyProfile(inst *mihomo.Instance, nodeName string, latencyTimeoutMs int) (*int, *int, *float64) {
	first := TestNodeLatency(inst, nodeName, latencyTimeoutMs)
	if first == nil {
		return nil, nil, nil
	}
	samples := []*int{first}
	for i := 0; i < 2; i++ {
		samples = append(samples, TestNodeLatency(inst, nodeName, latencyTimeoutMs))
	}
	return computeLatencyStats(samples)
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
	valueScore := ComputeCompositeValueScore(steadySpeed, avgSpeed, mult, nil, nil, nil)
	return round2(avgSpeed), round2(steadySpeed), valueScore
}

// ComputeCompositeValueScore 基于稳态速度、倍率、延迟、抖动与丢包率计算综合性价比分。
func ComputeCompositeValueScore(steadySpeed, avgSpeed, multiplier float64, latencyMs *int, jitterMs *int, packetLoss *float64) float64 {
	baseSpeed := steadySpeed
	if baseSpeed <= 0 {
		baseSpeed = avgSpeed
	}
	if baseSpeed <= 0 {
		return 0
	}
	mult := multiplier
	if mult <= 0 {
		mult = 1.0
	}

	latencyFactor := 1.0
	if latencyMs != nil {
		lat := *latencyMs
		if lat > 300 {
			latencyFactor = 0.50
		} else if lat > 80 {
			latencyFactor = 1.0 - float64(lat-80)/220.0*0.35
		}
	}

	jitterFactor := 1.0
	if jitterMs != nil {
		jit := *jitterMs
		if jit > 120 {
			jitterFactor = 0.75
		} else if jit > 20 {
			jitterFactor = 1.0 - float64(jit-20)/100.0*0.20
		}
	}

	lossFactor := 1.0
	if packetLoss != nil && *packetLoss > 0 {
		lossFactor = 1.0 - (*packetLoss/100.0)*2.5
		if lossFactor < 0.30 {
			lossFactor = 0.30
		}
	}

	return round2((baseSpeed / mult) * latencyFactor * jitterFactor * lossFactor)
}

// ResolveEffectiveMaxBytes 结合本地直连稳态带宽动态保护稳态采样窗口，防止高带宽节点未过预热期即触顶熔断。
func ResolveEffectiveMaxBytes(s config.Settings) int64 {
	maxBytes := s.MaxBytesPerNode
	if maxBytes <= 0 {
		maxBytes = 10 * 1024 * 1024
	}
	if s.LocalSteadyMBps > 0 {
		// 目标：至少撑过 1.5s 预热 + 2.5s 稳态采样（约 4s 满速流量），单节点自适应封顶 100MB
		adaptive := int64(s.LocalSteadyMBps * 4.0 * 1024 * 1024)
		const maxAdaptiveCap = int64(100 * 1024 * 1024)
		if adaptive > maxAdaptiveCap {
			adaptive = maxAdaptiveCap
		}
		if adaptive > maxBytes {
			maxBytes = adaptive
		}
	}
	return maxBytes
}

var defaultFallbackTestURLs = []string{
	"https://dl.google.com/chrome/mac/universal/stable/GGRO/googlechrome.dmg",
	"https://speed.cloudflare.com/__down?bytes=25000000",
	"https://cachefly.cachefly.net/100mb.test",
	"https://fsn1-speed.hetzner.com/100MB.bin",
}

func pickFallbackTestURL(primaryURL string) string {
	for _, u := range defaultFallbackTestURLs {
		if u != primaryURL {
			return u
		}
	}
	return ""
}

func RunStreamDownloadTest(parentCtx context.Context, mixedPort int, testURL string, maxBytesPerNode int64, downloadTimeoutMs int, multiplier float64) (bool, int64, float64, float64, float64, string) {
	return runStreamDownloadTestWithLimiter(parentCtx, mixedPort, testURL, maxBytesPerNode, downloadTimeoutMs, multiplier, nil)
}

func runMultiStreamDownloadTestWithLimiter(parentCtx context.Context, mixedPort int, testURL string, maxBytesPerNode int64, downloadTimeoutMs int, multiplier float64, limiter *BandwidthLimiter, streams int) (bool, int64, float64, float64, float64, string) {
	if streams <= 1 {
		return runStreamDownloadTestWithLimiter(parentCtx, mixedPort, testURL, maxBytesPerNode, downloadTimeoutMs, multiplier, limiter)
	}
	if streams > 8 {
		streams = 8
	}
	proxyURL, _ := url.Parse(fmt.Sprintf("http://127.0.0.1:%d", mixedPort))
	transport := &http.Transport{
		Proxy:               http.ProxyURL(proxyURL),
		DisableKeepAlives:   true,
		MaxIdleConnsPerHost: streams + 2,
		TLSHandshakeTimeout: 5 * time.Second,
	}
	defer transport.CloseIdleConnections()
	return runMultiStreamWithTransport(parentCtx, transport, testURL, maxBytesPerNode, downloadTimeoutMs, multiplier, limiter, streams)
}

func runMultiStreamWithTransport(parentCtx context.Context, transport *http.Transport, testURL string, maxBytesPerNode int64, downloadTimeoutMs int, multiplier float64, limiter *BandwidthLimiter, streams int) (bool, int64, float64, float64, float64, string) {
	if streams < 1 {
		streams = 1
	}
	ctx, cancel := context.WithTimeout(parentCtx, time.Duration(downloadTimeoutMs)*time.Millisecond)
	defer cancel()

	client := &http.Client{Transport: transport}
	startTime := time.Now()

	var totalBytes atomic.Int64
	var steadyBytes atomic.Int64
	var steadyStartNano atomic.Int64
	var abortedByCap atomic.Bool
	var completedStreams atomic.Int32
	var errMu sync.Mutex
	var firstErr string

	var wg sync.WaitGroup
	for i := 0; i < streams; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			req, err := http.NewRequestWithContext(ctx, http.MethodGet, testURL, nil)
			if err != nil {
				errMu.Lock()
				if firstErr == "" {
					firstErr = err.Error()
				}
				errMu.Unlock()
				return
			}
			resp, err := client.Do(req)
			if err != nil {
				errMu.Lock()
				if firstErr == "" {
					firstErr = err.Error()
				}
				errMu.Unlock()
				return
			}
			defer resp.Body.Close()

			if resp.StatusCode < 200 || resp.StatusCode >= 300 {
				errMu.Lock()
				if firstErr == "" {
					firstErr = fmt.Sprintf("HTTP %d", resp.StatusCode)
				}
				errMu.Unlock()
				return
			}

			buf := make([]byte, 32*1024)
			for {
				n, readErr := resp.Body.Read(buf)
				if n > 0 {
					if limiter != nil {
						if limErr := limiter.Consume(ctx, n); limErr != nil {
							errMu.Lock()
							if firstErr == "" {
								firstErr = limErr.Error()
							}
							errMu.Unlock()
							return
						}
					}
					now := time.Now()
					curTotal := totalBytes.Add(int64(n))
					if now.Sub(startTime).Milliseconds() >= steadyWarmupMs {
						steadyStartNano.CompareAndSwap(0, now.UnixNano())
						steadyBytes.Add(int64(n))
					}
					if curTotal >= maxBytesPerNode {
						if abortedByCap.CompareAndSwap(false, true) {
							cancel()
						}
						return
					}
				}
				if readErr != nil {
					if readErr == io.EOF {
						completedStreams.Add(1)
					} else {
						errMu.Lock()
						if firstErr == "" {
							firstErr = readErr.Error()
						}
						errMu.Unlock()
					}
					return
				}
			}
		}()
	}
	wg.Wait()

	endTime := time.Now()
	total := totalBytes.Load()
	steadyTotal := steadyBytes.Load()
	var steadyStartTime *time.Time
	if nano := steadyStartNano.Load(); nano > 0 {
		t := time.Unix(0, nano)
		steadyStartTime = &t
	}

	hasValidPartial := total > minValidBytesOnAbort
	if abortedByCap.Load() || completedStreams.Load() > 0 || hasValidPartial {
		avg, steady, val := computeMetrics(total, steadyTotal, startTime, steadyStartTime, endTime, multiplier)
		return true, total, avg, steady, val, ""
	}

	if firstErr != "" {
		return false, total, 0, 0, 0, firstErr
	}
	return false, total, 0, 0, 0, "下载失败且数据不足 512KB"
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
		lat, jitter, loss := TestNodeLatencyProfile(inst, node.Name, s.LatencyTimeoutMs)
		if lat == nil {
			record = NodeResult{
				Name:       node.Name,
				Type:       node.Type,
				Multiplier: node.Multiplier,
				Status:     "Dead / Timeout",
			}
		} else {
			streams := s.DownloadStreams
			if streams <= 0 {
				streams = 4
			}
			effectiveMaxBytes := ResolveEffectiveMaxBytes(s)
			ok, totalBytes, avg, steady, val, errMsg := runMultiStreamDownloadTestWithLimiter(
				ctx,
				mixedPort,
				s.TestURL,
				effectiveMaxBytes,
				s.DownloadTimeoutMs,
				node.Multiplier,
				limiter,
				streams,
			)
			// 主测速源失败（如遇到 403/429 风控盾或源站波动）时，自动使用备用全球 CDN 兜底重试一次
			if !ok && ctx.Err() == nil {
				if fallbackURL := pickFallbackTestURL(s.TestURL); fallbackURL != "" {
					fbOk, fbBytes, fbAvg, fbSteady, fbVal, fbErr := runMultiStreamDownloadTestWithLimiter(
						ctx,
						mixedPort,
						fallbackURL,
						effectiveMaxBytes,
						s.DownloadTimeoutMs,
						node.Multiplier,
						limiter,
						streams,
					)
					if fbOk {
						ok, totalBytes, avg, steady, val, errMsg = fbOk, fbBytes, fbAvg, fbSteady, fbVal, ""
					} else if fbErr != "" && errMsg != "" {
						errMsg = fmt.Sprintf("%s (备用源亦失败: %s)", errMsg, fbErr)
					}
				}
			}
			if ok {
				val = ComputeCompositeValueScore(steady, avg, node.Multiplier, lat, jitter, loss)
			}
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
				JitterMs:        jitter,
				PacketLoss:      loss,
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
