package vpn

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

type SelectorInfo struct {
	Name     string `json:"name"`
	Now      string `json:"now"`
	AllCount int    `json:"allCount"`
	HasNode  bool   `json:"hasNode,omitempty"`
}

type ProbeResult struct {
	Online    bool           `json:"online"`
	APIURL    string         `json:"apiUrl"`
	Selectors []SelectorInfo `json:"selectors"`
	Error     string         `json:"error,omitempty"`
}

type ApplyResult struct {
	Applied  bool   `json:"applied"`
	Selector string `json:"selector"`
	NodeName string `json:"nodeName"`
	Message  string `json:"message,omitempty"`
}

type proxyEntry struct {
	Name string   `json:"name"`
	Type string   `json:"type"`
	Now  string   `json:"now"`
	All  []string `json:"all"`
}

func normalizeAPIURL(raw string) string {
	base := strings.TrimRight(strings.TrimSpace(raw), "/")
	if base == "" {
		return ""
	}
	if !strings.HasPrefix(base, "http://") && !strings.HasPrefix(base, "https://") {
		base = "http://" + base
	}
	return base
}

func fetchProxiesMap(apiURL, secret string) (map[string]proxyEntry, error) {
	base := normalizeAPIURL(apiURL)
	if base == "" {
		return nil, fmt.Errorf("未配置控制 API 地址")
	}

	client := &http.Client{Timeout: 2500 * time.Millisecond}
	req, err := http.NewRequest(http.MethodGet, base+"/proxies", nil)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(secret) != "" {
		req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(secret))
	}

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		if resp.StatusCode == http.StatusBadRequest {
			return nil, fmt.Errorf("API 返回 HTTP 400（请确认填写的是「外部控制」端口如 9097/9090，而不是代理端口 7890）")
		}
		if resp.StatusCode == http.StatusUnauthorized {
			return nil, fmt.Errorf("API 返回 HTTP 401（Secret 密钥不正确或未填写）")
		}
		return nil, fmt.Errorf("API 返回 HTTP %d", resp.StatusCode)
	}

	var payload struct {
		Proxies map[string]proxyEntry `json:"proxies"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil, fmt.Errorf("解析代理列表失败: %w", err)
	}
	return payload.Proxies, nil
}

func selectorPriority(name string) int {
	lower := strings.ToLower(strings.TrimSpace(name))
	if lower == "global" {
		return 10
	}
	exactMain := []string{"节点选择", "proxy", "代理选择", "代理模式", "select", "国外流量"}
	for _, kw := range exactMain {
		if lower == kw {
			return 120
		}
	}
	mainKeywords := []string{"节点选择", "代理", "proxy", "select"}
	for _, kw := range mainKeywords {
		if strings.Contains(lower, kw) && !strings.Contains(lower, "不走代理") && !strings.Contains(lower, "直连") {
			return 100
		}
	}
	if strings.Contains(lower, "手动") {
		return 85
	}
	if strings.Contains(lower, "漏网之鱼") || strings.Contains(lower, "final") {
		return 40
	}
	return 20
}

// ProbeController 探测指定 Clash/Mihomo External Controller 是否在线，并列出 Selector 策略组。
func ProbeController(apiURL, secret, nodeName string) ProbeResult {
	base := normalizeAPIURL(apiURL)
	proxiesMap, err := fetchProxiesMap(base, secret)
	if err != nil {
		return ProbeResult{
			Online:    false,
			APIURL:    base,
			Selectors: []SelectorInfo{},
			Error:     err.Error(),
		}
	}

	orderMap := make(map[string]int)
	if globalProxy, ok := proxiesMap["GLOBAL"]; ok {
		for idx, name := range globalProxy.All {
			if _, exists := orderMap[name]; !exists {
				orderMap[name] = idx
			}
		}
	}

	selectors := make([]SelectorInfo, 0)
	var globalEntry *SelectorInfo

	for key, info := range proxiesMap {
		if !strings.EqualFold(info.Type, "Selector") {
			continue
		}
		name := info.Name
		if name == "" {
			name = key
		}
		hasNode := false
		if nodeName != "" {
			for _, candidate := range info.All {
				if candidate == nodeName {
					hasNode = true
					break
				}
			}
		}
		item := SelectorInfo{
			Name:     name,
			Now:      info.Now,
			AllCount: len(info.All),
			HasNode:  hasNode,
		}
		if name == "GLOBAL" {
			globalEntry = &item
			continue
		}
		selectors = append(selectors, item)
	}

	sort.Slice(selectors, func(i, j int) bool {
		if selectors[i].HasNode != selectors[j].HasNode {
			return selectors[i].HasNode
		}
		oi, oki := orderMap[selectors[i].Name]
		oj, okj := orderMap[selectors[j].Name]
		if oki && okj && oi != oj {
			return oi < oj
		}
		if oki != okj {
			return oki
		}
		pi, pj := selectorPriority(selectors[i].Name), selectorPriority(selectors[j].Name)
		if pi != pj {
			return pi > pj
		}
		return selectors[i].Name < selectors[j].Name
	})
	if globalEntry != nil {
		selectors = append(selectors, *globalEntry)
	}

	return ProbeResult{
		Online:    true,
		APIURL:    base,
		Selectors: selectors,
	}
}

// ApplyNode 将目标节点应用到指定 Clash/Mihomo 客户端的 Selector 策略组。
func ApplyNode(apiURL, secret, selector, nodeName string) (ApplyResult, error) {
	base := normalizeAPIURL(apiURL)
	if strings.TrimSpace(nodeName) == "" {
		return ApplyResult{}, fmt.Errorf("节点名称不能为空")
	}

	targetSelector := strings.TrimSpace(selector)
	if targetSelector == "" {
		probe := ProbeController(base, secret, nodeName)
		if !probe.Online {
			return ApplyResult{}, fmt.Errorf("客户端未在线或无法连接 (%s)", probe.Error)
		}
		for _, sel := range probe.Selectors {
			if sel.HasNode && sel.Name != "GLOBAL" {
				targetSelector = sel.Name
				break
			}
		}
		if targetSelector == "" && len(probe.Selectors) > 0 {
			targetSelector = probe.Selectors[0].Name
		}
		if targetSelector == "" {
			return ApplyResult{}, fmt.Errorf("未在客户端中找到可用的 Selector 策略组")
		}
	}

	body, _ := json.Marshal(map[string]string{"name": nodeName})
	endpoint := fmt.Sprintf("%s/proxies/%s", base, url.PathEscape(targetSelector))
	client := &http.Client{Timeout: 2500 * time.Millisecond}
	req, err := http.NewRequest(http.MethodPut, endpoint, bytes.NewReader(body))
	if err != nil {
		return ApplyResult{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	if strings.TrimSpace(secret) != "" {
		req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(secret))
	}

	resp, err := client.Do(req)
	if err != nil {
		return ApplyResult{}, fmt.Errorf("连接客户端失败: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusOK {
		return ApplyResult{}, fmt.Errorf("切换节点失败 (策略组 %s): HTTP %d（请确认该策略组包含节点 %s）", targetSelector, resp.StatusCode, nodeName)
	}

	return ApplyResult{
		Applied:  true,
		Selector: targetSelector,
		NodeName: nodeName,
		Message:  fmt.Sprintf("已将「%s」应用到策略组「%s」", nodeName, targetSelector),
	}, nil
}
