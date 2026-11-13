package mihomo

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

var allowedProxyTypes = map[string]bool{
	"ss":           true,
	"shadowsocks":  true,
	"ssr":          true,
	"shadowsocksr": true,
	"vmess":        true,
	"vless":        true,
	"trojan":       true,
	"hysteria":     true,
	"hysteria2":    true,
	"tuic":         true,
	"anytls":       true,
	"wireguard":    true,
	"socks5":       true,
	"http":         true,
}

var multiplierRegex = regexp.MustCompile(`(\d+(?:\.\d+)?)\s*[xX倍]`)

type regionDef struct {
	terms []string
	codes []string
}

var regionDefinitions = map[string]regionDef{
	"ASIA": {
		terms: []string{
			"亚洲", "香港", "hong kong", "hongkong", "🇭🇰",
			"台湾", "台灣", "taiwan", "🇹🇼",
			"日本", "japan", "tokyo", "osaka", "🇯🇵",
			"新加坡", "狮城", "singapore", "🇸🇬",
			"韩国", "韓國", "korea", "seoul", "🇰🇷",
			"澳门", "macau", "🇲🇴",
			"马来西亚", "malaysia", "🇲🇾",
			"泰国", "thailand", "bangkok", "🇹🇭",
			"越南", "vietnam", "🇻🇳",
			"印度", "india", "mumbai", "🇮🇳",
			"印尼", "indonesia", "🇮🇩",
			"菲律宾", "philippines", "🇵🇭",
		},
		codes: []string{"hk", "tw", "jp", "sg", "kr", "mo", "my", "th", "vn", "in", "id", "ph", "asia"},
	},
	"EU": {
		terms: []string{
			"欧洲", "英国", "德国", "法国", "荷兰", "瑞士", "瑞典", "意大利", "西班牙", "波兰", "爱尔兰", "芬兰", "挪威", "土耳其",
			"london", "frankfurt", "paris", "amsterdam", "zurich", "istanbul",
			"🇬🇧", "🇩🇪", "🇫🇷", "🇳🇱", "🇨🇭", "🇸🇪", "🇮🇹", "🇪🇸", "🇵🇱", "🇮🇪", "🇫🇮", "🇳🇴", "🇹🇷", "🇪🇺",
		},
		codes: []string{"uk", "gb", "de", "fr", "nl", "ch", "se", "it", "es", "pl", "ie", "fi", "no", "tr", "eu"},
	},
	"AMERICA": {
		terms: []string{
			"美洲", "北美", "南美", "美国", "united states", "america", "🇺🇸",
			"加拿大", "canada", "toronto", "vancouver", "🇨🇦",
			"墨西哥", "mexico", "🇲🇽",
			"巴西", "brazil", "🇧🇷",
			"阿根廷", "argentina", "🇦🇷",
			"智利", "chile", "🇨🇱",
		},
		codes: []string{"us", "usa", "ca", "mx", "br", "ar", "cl"},
	},
	"OCEANIA": {
		terms: []string{
			"大洋洲", "澳洲", "澳大利亚", "australia", "sydney", "melbourne", "🇦🇺",
			"新西兰", "new zealand", "auckland", "🇳🇿",
		},
		codes: []string{"au", "nz"},
	},
	"HK": {terms: []string{"香港", "hong kong", "hongkong", "🇭🇰"}, codes: []string{"hk"}},
	"TW": {terms: []string{"台湾", "台灣", "taiwan", "🇹🇼"}, codes: []string{"tw"}},
	"JP": {terms: []string{"日本", "japan", "tokyo", "osaka", "🇯🇵"}, codes: []string{"jp"}},
	"SG": {terms: []string{"新加坡", "狮城", "singapore", "🇸🇬"}, codes: []string{"sg"}},
	"US": {terms: []string{"美国", "united states", "america", "🇺🇸"}, codes: []string{"us", "usa"}},
	"KR": {terms: []string{"韩国", "韓國", "korea", "seoul", "🇰🇷"}, codes: []string{"kr"}},
}

var shortAlphaCode = regexp.MustCompile(`^[a-zA-Z]{2,3}$`)

func matchesKeywordList(name string, keywords []string) bool {
	lower := strings.ToLower(name)
	for _, raw := range keywords {
		kw := strings.TrimSpace(raw)
		if kw == "" {
			continue
		}
		if shortAlphaCode.MatchString(kw) {
			re := regexp.MustCompile(fmt.Sprintf(`(?i)(?:^|[^a-zA-Z0-9])%s(?:[^a-zA-Z0-9]|$)`, regexp.QuoteMeta(kw)))
			if re.MatchString(name) {
				return true
			}
			continue
		}
		if strings.Contains(lower, strings.ToLower(kw)) {
			return true
		}
	}
	return false
}

func matchesRegion(name, regionCode string, customRegionKeywords map[string][]string) bool {
	code := strings.ToUpper(strings.TrimSpace(regionCode))
	if customRegionKeywords != nil {
		if list, ok := customRegionKeywords[code]; ok && len(list) > 0 {
			return matchesKeywordList(name, list)
		}
	}
	def, ok := regionDefinitions[code]
	if !ok {
		return false
	}
	return matchesKeywordList(name, append(append([]string(nil), def.terms...), def.codes...))
}

type ProxyNode struct {
	Name       string
	Type       string
	Multiplier float64
}

type Instance struct {
	cmd              *exec.Cmd
	ControllerPort   int
	ControllerSecret string
	Client           *http.Client
	mu               sync.Mutex
	stopped          bool
}

func ExtractMultiplier(name string) float64 {
	m := multiplierRegex.FindStringSubmatch(name)
	if len(m) < 2 {
		return 1.0
	}
	v, err := strconv.ParseFloat(m[1], 64)
	if err != nil || v <= 0 {
		return 1.0
	}
	return v
}

func FilterAndNormalizeProxies(proxiesMap map[string]struct {
	Name string `json:"name"`
	Type string `json:"type"`
}, excludeKeywords, includeRegions, includeKeywords []string, regionKeywords map[string][]string) []ProxyNode {
	var lowerKeywords []string
	for _, kw := range excludeKeywords {
		if t := strings.TrimSpace(strings.ToLower(kw)); t != "" {
			lowerKeywords = append(lowerKeywords, t)
		}
	}
	var lowerIncludes []string
	for _, kw := range includeKeywords {
		if t := strings.TrimSpace(strings.ToLower(kw)); t != "" {
			lowerIncludes = append(lowerIncludes, t)
		}
	}
	hasIncludeFilter := len(includeRegions) > 0 || len(lowerIncludes) > 0

	var result []ProxyNode
	for key, info := range proxiesMap {
		name := info.Name
		if name == "" {
			name = key
		}
		rawType := strings.TrimSpace(info.Type)
		if !allowedProxyTypes[strings.ToLower(rawType)] {
			continue
		}
		lowerName := strings.ToLower(name)
		excluded := false
		for _, kw := range lowerKeywords {
			if strings.Contains(lowerName, kw) {
				excluded = true
				break
			}
		}
		if excluded {
			continue
		}
		if hasIncludeFilter {
			matched := false
			for _, r := range includeRegions {
				if matchesRegion(name, r, regionKeywords) {
					matched = true
					break
				}
			}
			if !matched {
				for _, kw := range lowerIncludes {
					if strings.Contains(lowerName, kw) {
						matched = true
						break
					}
				}
			}
			if !matched {
				continue
			}
		}
		result = append(result, ProxyNode{
			Name:       name,
			Type:       rawType,
			Multiplier: ExtractMultiplier(name),
		})
	}
	return result
}

func StartProcess(binaryPath, configsDir, runtimeYAMLPath string, controllerPort int, controllerSecret string, hasProviders bool) (*Instance, error) {
	cmd := exec.Command(binaryPath, "-d", configsDir, "-f", runtimeYAMLPath)
	hideWindow(cmd)
	var logBuf bytes.Buffer
	cmd.Stdout = &logBuf
	cmd.Stderr = &logBuf

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("启动 Mihomo 内核失败: %w", err)
	}

	exited := make(chan error, 1)
	go func() {
		exited <- cmd.Wait()
	}()

	inst := &Instance{
		cmd:              cmd,
		ControllerPort:   controllerPort,
		ControllerSecret: controllerSecret,
		Client: &http.Client{
			Timeout:   5 * time.Second,
			Transport: &http.Transport{Proxy: nil},
		},
	}

	deadline := time.Now().Add(15 * time.Second)
	ready := false
	for time.Now().Before(deadline) {
		select {
		case err := <-exited:
			return nil, fmt.Errorf("Mihomo 内核提前退出 (%v)\n日志:\n%s", err, logBuf.String())
		default:
		}
		resp, err := inst.ControllerRequest(http.MethodGet, "/version", nil)
		if err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				ready = true
				break
			}
		}
		time.Sleep(200 * time.Millisecond)
	}

	if !ready {
		_ = inst.Stop()
		return nil, fmt.Errorf("等待 Mihomo Controller API 超时\n日志:\n%s", logBuf.String())
	}

	if hasProviders {
		pDeadline := time.Now().Add(10 * time.Second)
		for time.Now().Before(pDeadline) {
			resp, err := inst.ControllerRequest(http.MethodGet, "/providers/proxies", nil)
			if err == nil {
				var data struct {
					Providers map[string]struct {
						Proxies []any `json:"proxies"`
					} `json:"providers"`
				}
				_ = json.NewDecoder(resp.Body).Decode(&data)
				_ = resp.Body.Close()
				loaded := false
				for _, p := range data.Providers {
					if len(p.Proxies) > 0 {
						loaded = true
						break
					}
				}
				if loaded {
					break
				}
			}
			time.Sleep(250 * time.Millisecond)
		}
	}

	return inst, nil
}

func (i *Instance) ControllerRequest(method, apiPath string, body io.Reader) (*http.Response, error) {
	urlStr := fmt.Sprintf("http://127.0.0.1:%d%s", i.ControllerPort, apiPath)
	req, err := http.NewRequest(method, urlStr, body)
	if err != nil {
		return nil, err
	}
	if i.ControllerSecret != "" {
		req.Header.Set("Authorization", "Bearer "+i.ControllerSecret)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return i.Client.Do(req)
}

func (i *Instance) FetchFilteredProxies(excludeKeywords, includeRegions, includeKeywords []string, regionKeywords map[string][]string) ([]ProxyNode, error) {
	resp, err := i.ControllerRequest(http.MethodGet, "/proxies", nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("获取节点列表失败: HTTP %d", resp.StatusCode)
	}
	var payload struct {
		Proxies map[string]struct {
			Name string `json:"name"`
			Type string `json:"type"`
		} `json:"proxies"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil, err
	}
	return FilterAndNormalizeProxies(payload.Proxies, excludeKeywords, includeRegions, includeKeywords, regionKeywords), nil
}

func (i *Instance) Stop() error {
	i.mu.Lock()
	defer i.mu.Unlock()
	if i.stopped {
		return nil
	}
	i.stopped = true
	if i.cmd != nil && i.cmd.Process != nil {
		_ = i.cmd.Process.Kill()
	}
	return nil
}
