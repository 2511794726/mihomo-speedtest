package tester

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

type UnlockInfo struct {
	IP          string `json:"ip,omitempty"`
	CountryCode string `json:"countryCode,omitempty"`
	Country     string `json:"country,omitempty"`
	ISP         string `json:"isp,omitempty"`
	IPType      string `json:"ipType,omitempty"`
	ChatGPT     string `json:"chatgpt,omitempty"`
	Netflix     string `json:"netflix,omitempty"`
}

func classifyIPType(hosting, mobile bool) string {
	if hosting {
		return "datacenter"
	}
	if mobile {
		return "mobile"
	}
	return "residential"
}

var openaiBlockedCountries = map[string]bool{
	"CN": true, "HK": true, "MO": true, "RU": true, "BY": true,
	"IR": true, "KP": true, "CU": true, "SY": true, "AF": true,
}

func newProxyHTTPClient(mixedPort int, timeout time.Duration) (*http.Client, *http.Transport) {
	proxyURL, _ := url.Parse(fmt.Sprintf("http://127.0.0.1:%d", mixedPort))
	transport := &http.Transport{
		Proxy:               http.ProxyURL(proxyURL),
		DisableKeepAlives:   true,
		TLSHandshakeTimeout: 4 * time.Second,
	}
	return &http.Client{
		Transport: transport,
		Timeout:   timeout,
	}, transport
}

func probeIPGeo(ctx context.Context, client *http.Client, info *UnlockInfo) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://ip-api.com/json/?lang=zh-CN&fields=status,country,countryCode,isp,query,hosting,mobile", nil)
	if err != nil {
		return
	}
	resp, err := client.Do(req)
	if err != nil {
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return
	}
	var payload struct {
		Status      string `json:"status"`
		Country     string `json:"country"`
		CountryCode string `json:"countryCode"`
		ISP         string `json:"isp"`
		Query       string `json:"query"`
		Hosting     bool   `json:"hosting"`
		Mobile      bool   `json:"mobile"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return
	}
	if payload.Status == "success" {
		info.IP = payload.Query
		info.CountryCode = strings.ToUpper(strings.TrimSpace(payload.CountryCode))
		info.Country = payload.Country
		info.ISP = payload.ISP
		info.IPType = classifyIPType(payload.Hosting, payload.Mobile)
	}
}

func probeChatGPT(ctx context.Context, client *http.Client) string {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://chatgpt.com/cdn-cgi/trace", nil)
	if err != nil {
		return "unknown"
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36")
	resp, err := client.Do(req)
	if err != nil {
		return "unknown"
	}
	bodyBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	_ = resp.Body.Close()

	if resp.StatusCode == http.StatusOK {
		for _, line := range strings.Split(string(bodyBytes), "\n") {
			if strings.HasPrefix(line, "loc=") {
				loc := strings.ToUpper(strings.TrimSpace(strings.TrimPrefix(line, "loc=")))
				if openaiBlockedCountries[loc] {
					return "no"
				}
				break
			}
		}
	}

	// 进一步验证 OpenAI API 入口是否被区域或风控拦截
	apiReq, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.openai.com/v1/models", nil)
	if err != nil {
		return "unknown"
	}
	apiReq.Header.Set("User-Agent", "Mozilla/5.0")
	apiResp, err := client.Do(apiReq)
	if err != nil {
		return "unknown"
	}
	apiBody, _ := io.ReadAll(io.LimitReader(apiResp.Body, 2048))
	_ = apiResp.Body.Close()

	if apiResp.StatusCode == http.StatusUnauthorized || apiResp.StatusCode == http.StatusOK {
		return "yes"
	}
	if apiResp.StatusCode == http.StatusForbidden {
		lower := strings.ToLower(string(apiBody))
		if strings.Contains(lower, "unsupported_country") || strings.Contains(lower, "forbidden") {
			return "no"
		}
		return "no"
	}
	return "unknown"
}

func probeNetflixURL(ctx context.Context, client *http.Client, targetURL string) int {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, targetURL, nil)
	if err != nil {
		return 0
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
	resp, err := client.Do(req)
	if err != nil {
		return 0
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1024))
	_ = resp.Body.Close()
	return resp.StatusCode
}

func probeNetflix(ctx context.Context, client *http.Client) string {
	// 70143836 = Breaking Bad (非自制剧); 80018499 = 自制剧
	code := probeNetflixURL(ctx, client, "https://www.netflix.com/title/70143836")
	if code == http.StatusOK {
		return "full"
	}
	if code == 0 {
		return "unknown"
	}
	origCode := probeNetflixURL(ctx, client, "https://www.netflix.com/title/80018499")
	if origCode == http.StatusOK {
		return "originals"
	}
	if origCode == http.StatusForbidden || origCode == http.StatusNotFound {
		return "no"
	}
	return "unknown"
}

// ProbeNodeUnlock 并发探测当前节点出口 IP 归属地与 ChatGPT/Netflix 解锁情况。
func ProbeNodeUnlock(parentCtx context.Context, mixedPort int) *UnlockInfo {
	ctx, cancel := context.WithTimeout(parentCtx, 4500*time.Millisecond)
	defer cancel()

	client, transport := newProxyHTTPClient(mixedPort, 4500*time.Millisecond)
	defer transport.CloseIdleConnections()

	info := &UnlockInfo{
		ChatGPT: "unknown",
		Netflix: "unknown",
	}

	var wg sync.WaitGroup
	wg.Add(3)
	go func() {
		defer wg.Done()
		probeIPGeo(ctx, client, info)
	}()
	go func() {
		defer wg.Done()
		info.ChatGPT = probeChatGPT(ctx, client)
	}()
	go func() {
		defer wg.Done()
		info.Netflix = probeNetflix(ctx, client)
	}()
	wg.Wait()

	return info
}
