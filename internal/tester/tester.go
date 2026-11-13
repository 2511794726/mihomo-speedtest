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
	AvgSpeedMBps    float64 `json:"avgSpeedMBps"`
	SteadySpeedMBps float64 `json:"steadySpeedMBps"`
	ValueScore      float64 `json:"valueScore"`
	Error           string  `json:"error,omitempty"`
}

func round2(v float64) float64 {
	return math.Round(v*100) / 100
}

func SwitchGlobalProxy(inst *mihomo.Instance, nodeName string) error {
	body, _ := json.Marshal(map[string]string{"name": nodeName})
	resp, err := inst.ControllerRequest(http.MethodPut, "/proxies/GLOBAL", bytes.NewReader(body))
	if err != nil {
		return err
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusOK {
		return fmt.Errorf("切换 GLOBAL 节点失败 (%s): HTTP %d", nodeName, resp.StatusCode)
	}
	return nil
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

func RunSerialSpeedTests(ctx context.Context, nodes []mihomo.ProxyNode, inst *mihomo.Instance, mixedPort int, s config.Settings, onProgress func(index, total int, res NodeResult)) []NodeResult {
	total := len(nodes)
	results := make([]NodeResult, 0, total)

	for i, node := range nodes {
		if ctx.Err() != nil {
			break
		}
		index := i + 1
		var record NodeResult

		if err := SwitchGlobalProxy(inst, node.Name); err != nil {
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
				ok, totalBytes, avg, steady, val, errMsg := RunStreamDownloadTest(
					ctx,
					mixedPort,
					s.TestURL,
					s.MaxBytesPerNode,
					s.DownloadTimeoutMs,
					node.Multiplier,
				)
				status := "OK"
				if !ok {
					status = "Download Failed"
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
				}
			}
		}

		results = append(results, record)
		if onProgress != nil {
			onProgress(index, total, record)
		}
	}

	return results
}
