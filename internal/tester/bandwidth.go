package tester

import (
	"context"
	"errors"
	"io"
	"math"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// BandwidthTestResult 记录本地直连宽带上限压测结果。
type BandwidthTestResult struct {
	Mode            string   `json:"mode"`
	UsedURL         string   `json:"usedUrl"`
	UsedURLs        []string `json:"usedUrls"`
	PeakMBps        float64  `json:"peakMBps"`
	SteadyMBps      float64  `json:"steadyMBps"`
	PeakMbps        int      `json:"peakMbps"`
	RecommendedMBps float64  `json:"recommendedMBps"`
	TotalBytes      int64    `json:"totalBytes"`
	DurationMs      int64    `json:"durationMs"`
}

var domesticBandwidthURLs = []string{
	"https://mirrors.aliyun.com/centos-stream/9-stream/BaseOS/x86_64/os/images/install.img",
	"https://dldir1v6.qq.com/weixin/Windows/WeChatSetup.exe",
	"https://update.code.visualstudio.com/latest/win32-x64-user/stable",
	"https://issuecdn.baidupcs.com/issue/netdisk/yunguanjia/BaiduNetdisk_7.42.0.5.exe",
	"https://speed.cloudflare.com/__down?bytes=50000000",
}

func newDirectHTTPClient() *http.Client {
	tr := &http.Transport{
		Proxy: nil, // 强制直连本地网卡，绕过系统代理/VPN
		DialContext: (&net.Dialer{
			Timeout:   3 * time.Second,
			KeepAlive: 15 * time.Second,
		}).DialContext,
		MaxIdleConns:        32,
		MaxIdleConnsPerHost: 16,
		IdleConnTimeout:     30 * time.Second,
	}
	return &http.Client{Transport: tr}
}

func probeReachableBandwidthURLs(ctx context.Context, client *http.Client, candidates []string) []string {
	var mu sync.Mutex
	reachable := make([]string, 0, len(candidates))
	var wg sync.WaitGroup
	for _, raw := range candidates {
		u := strings.TrimSpace(raw)
		if u == "" {
			continue
		}
		wg.Add(1)
		go func(target string) {
			defer wg.Done()
			probeCtx, cancel := context.WithTimeout(ctx, 2500*time.Millisecond)
			defer cancel()
			req, err := http.NewRequestWithContext(probeCtx, http.MethodGet, target, nil)
			if err != nil {
				return
			}
			req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
			resp, err := client.Do(req)
			if err != nil {
				return
			}
			_ = resp.Body.Close()
			if resp.StatusCode >= 200 && resp.StatusCode < 400 {
				mu.Lock()
				reachable = append(reachable, target)
				mu.Unlock()
			}
		}(u)
	}
	wg.Wait()
	return reachable
}

// TestLocalBandwidth 使用多源 8 路并发直连下载流压测本地网络真实下载上限（约 6 秒）。
func TestLocalBandwidth(ctx context.Context, mode string, testURL string, customURL string) (BandwidthTestResult, error) {
	customURL = strings.TrimSpace(customURL)
	if customURL != "" {
		mode = "custom"
	} else if mode != "direct" {
		mode = "domestic"
	}

	client := newDirectHTTPClient()
	var activeURLs []string

	switch mode {
	case "custom":
		activeURLs = probeReachableBandwidthURLs(ctx, client, []string{customURL})
		if len(activeURLs) == 0 {
			return BandwidthTestResult{}, errors.New("自定义测速链接无法连接，请检查 URL 是否有效")
		}
	case "direct":
		if strings.TrimSpace(testURL) != "" {
			activeURLs = probeReachableBandwidthURLs(ctx, client, []string{testURL})
		}
		if len(activeURLs) == 0 {
			activeURLs = probeReachableBandwidthURLs(ctx, client, domesticBandwidthURLs)
		}
	default:
		// 国内多源混合并发：同时探测所有大厂 CDN，叠加多源带宽以突破单 CDN 限速
		activeURLs = probeReachableBandwidthURLs(ctx, client, domesticBandwidthURLs)
	}

	if len(activeURLs) == 0 {
		return BandwidthTestResult{}, errors.New("无法连接任何直连测速源，请检查本地网络连接")
	}

	const testDuration = 6000 * time.Millisecond
	const warmupDuration = 1000 * time.Millisecond
	const workerCount = 8

	runCtx, cancel := context.WithTimeout(ctx, testDuration)
	defer cancel()

	var totalBytes atomic.Int64
	var steadyBytes atomic.Int64
	startedAt := time.Now()

	var wg sync.WaitGroup
	for i := 0; i < workerCount; i++ {
		target := activeURLs[i%len(activeURLs)]
		wg.Add(1)
		go func(u string) {
			defer wg.Done()
			buf := make([]byte, 64*1024)
			for runCtx.Err() == nil {
				req, reqErr := http.NewRequestWithContext(runCtx, http.MethodGet, u, nil)
				if reqErr != nil {
					return
				}
				req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
				resp, respErr := client.Do(req)
				if respErr != nil {
					return
				}
				for runCtx.Err() == nil {
					n, readErr := resp.Body.Read(buf)
					if n > 0 {
						totalBytes.Add(int64(n))
						if time.Since(startedAt) >= warmupDuration {
							steadyBytes.Add(int64(n))
						}
					}
					if readErr != nil {
						if readErr == io.EOF {
							break
						}
						break
					}
				}
				_ = resp.Body.Close()
			}
		}(target)
	}

	type sample struct {
		at    time.Time
		bytes int64
	}
	samples := []sample{{at: startedAt, bytes: 0}}
	peakMBps := 0.0

	ticker := time.NewTicker(250 * time.Millisecond)
	doneCh := make(chan struct{})
	go func() {
		wg.Wait()
		close(doneCh)
	}()

loop:
	for {
		select {
		case <-doneCh:
			break loop
		case now := <-ticker.C:
			curBytes := totalBytes.Load()
			samples = append(samples, sample{at: now, bytes: curBytes})
			for idx := len(samples) - 2; idx >= 0; idx-- {
				dt := now.Sub(samples[idx].at).Seconds()
				if dt >= 0.45 {
					mbps := float64(curBytes-samples[idx].bytes) / (1024.0 * 1024.0) / dt
					if mbps > peakMBps {
						peakMBps = mbps
					}
					break
				}
			}
		}
	}
	ticker.Stop()

	elapsed := time.Since(startedAt)
	total := totalBytes.Load()
	if total == 0 {
		return BandwidthTestResult{}, errors.New("未收到测速数据，请稍后重试或填写自定义测速链接")
	}

	steadySecs := elapsed.Seconds() - warmupDuration.Seconds()
	steadyMBps := 0.0
	if steadySecs > 0.5 && steadyBytes.Load() > 0 {
		steadyMBps = float64(steadyBytes.Load()) / (1024.0 * 1024.0) / steadySecs
	} else {
		steadyMBps = float64(total) / (1024.0 * 1024.0) / math.Max(0.1, elapsed.Seconds())
	}
	if peakMBps < steadyMBps {
		peakMBps = steadyMBps
	}

	peakMBps = math.Round(peakMBps*10) / 10
	steadyMBps = math.Round(steadyMBps*10) / 10
	recommended := math.Round(peakMBps*0.9*10) / 10
	if recommended < 1.0 && peakMBps >= 1.0 {
		recommended = 1.0
	}

	return BandwidthTestResult{
		Mode:            mode,
		UsedURL:         strings.Join(activeURLs, " , "),
		UsedURLs:        activeURLs,
		PeakMBps:        peakMBps,
		SteadyMBps:      steadyMBps,
		PeakMbps:        int(math.Round(peakMBps * 8)),
		RecommendedMBps: recommended,
		TotalBytes:      total,
		DurationMs:      elapsed.Milliseconds(),
	}, nil
}
