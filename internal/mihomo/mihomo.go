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
	terms      []string
	codes      []string // 不区分大小写，前后非英文字母边界匹配（如 hk, jp, us, sg）
	upperCodes []string // 仅匹配全大写且前后非英文字母边界（避免 in/my/id/no/it 等英文单词误伤）
}

var regionDefinitions = map[string]regionDef{
	"ASIA": {
		terms: []string{
			"亚洲", "asia",
			"香港", "hong kong", "hongkong", "hkg", "🇭🇰",
			"台湾", "台灣", "台北", "taiwan", "taipei", "tpe", "🇹🇼",
			"日本", "东京", "大阪", "japan", "tokyo", "osaka", "nrt", "kix", "🇯🇵",
			"新加坡", "狮城", "singapore", "🇸🇬",
			"韩国", "韓國", "首尔", "korea", "seoul", "icn", "🇰🇷",
			"澳门", "macau", "🇲🇴",
			"马来西亚", "malaysia", "吉隆坡", "🇲🇾",
			"泰国", "thailand", "曼谷", "bangkok", "🇹🇭",
			"越南", "vietnam", "胡志明", "河内", "🇻🇳",
			"印度", "india", "孟买", "mumbai", "🇮🇳",
			"印尼", "印度尼西亚", "indonesia", "雅加达", "🇮🇩",
			"菲律宾", "philippines", "马尼拉", "🇵🇭",
			"阿联酋", "迪拜", "dubai", "🇦🇪",
			"以色列", "israel", "🇮🇱",
			"土耳其", "turkey", "伊斯坦布尔", "istanbul", "🇹🇷",
		},
		codes:      []string{"hk", "tw", "jp", "sg", "kr"},
		upperCodes: []string{"MO", "MY", "TH", "VN", "PH", "AE", "IL", "TR"},
	},
	"EU": {
		terms: []string{
			"欧洲", "europe",
			"英国", "united kingdom", "伦敦", "london", "🇬🇧",
			"德国", "germany", "法兰克福", "frankfurt", "🇩🇪",
			"法国", "france", "巴黎", "paris", "🇫🇷",
			"荷兰", "netherlands", "阿姆斯特丹", "amsterdam", "🇳🇱",
			"瑞士", "switzerland", "苏黎世", "zurich", "🇨🇭",
			"瑞典", "sweden", "斯德哥尔摩", "🇸🇪",
			"意大利", "italy", "米兰", "milan", "罗马", "🇮🇹",
			"西班牙", "spain", "马德里", "madrid", "巴塞罗那", "🇪🇸",
			"波兰", "poland", "华沙", "🇵🇱",
			"爱尔兰", "ireland", "都柏林", "🇮🇪",
			"芬兰", "finland", "赫尔辛基", "🇫🇮",
			"挪威", "norway", "🇳🇴",
			"俄罗斯", "russia", "莫斯科", "moscow", "🇷🇺",
			"土耳其", "turkey", "伊斯坦布尔", "istanbul", "🇹🇷",
			"🇪🇺",
		},
		codes:      []string{"uk", "gb", "de", "fr", "nl", "ch", "se", "ru", "eu"},
		upperCodes: []string{"ES", "PL", "IE", "FI", "TR"},
	},
	"AMERICA": {
		terms: []string{
			"美洲", "北美", "南美", "america",
			"美国", "united states", "洛杉矶", "圣何塞", "西雅图", "纽约", "芝加哥", "达拉斯", "迈阿密", "硅谷",
			"los angeles", "san jose", "seattle", "new york", "lax", "sjc", "🇺🇸",
			"加拿大", "canada", "多伦多", "温哥华", "蒙特利尔", "toronto", "vancouver", "🇨🇦",
			"墨西哥", "mexico", "🇲🇽",
			"巴西", "brazil", "圣保罗", "🇧🇷",
			"阿根廷", "argentina", "🇦🇷",
			"智利", "chile", "🇨🇱",
		},
		codes:      []string{"us", "usa"},
		upperCodes: []string{"CA", "MX", "BR", "AR", "CL"},
	},
	"OCEANIA": {
		terms: []string{
			"大洋洲", "oceania",
			"澳洲", "澳大利亚", "australia", "悉尼", "墨尔本", "sydney", "melbourne", "🇦🇺",
			"新西兰", "new zealand", "奥克兰", "auckland", "🇳🇿",
		},
		codes: []string{"au", "nz"},
	},
	"HK": {terms: []string{"香港", "hong kong", "hongkong", "hkg", "🇭🇰"}, codes: []string{"hk"}},
	"TW": {terms: []string{"台湾", "台灣", "台北", "taiwan", "taipei", "tpe", "🇹🇼"}, codes: []string{"tw"}},
	"JP": {terms: []string{"日本", "东京", "大阪", "japan", "tokyo", "osaka", "nrt", "kix", "🇯🇵"}, codes: []string{"jp"}},
	"SG": {terms: []string{"新加坡", "狮城", "singapore", "🇸🇬"}, codes: []string{"sg"}},
	"US": {terms: []string{"美国", "united states", "america", "洛杉矶", "圣何塞", "西雅图", "纽约", "los angeles", "san jose", "seattle", "new york", "🇺🇸"}, codes: []string{"us", "usa"}},
	"KR": {terms: []string{"韩国", "韓國", "首尔", "korea", "seoul", "icn", "🇰🇷"}, codes: []string{"kr"}},
}

var shortAlphaCode = regexp.MustCompile(`^[a-zA-Z]{2,3}$`)
var caseSensitiveShortCodes = map[string]bool{
	"mo": true, "my": true, "th": true, "vn": true, "in": true, "id": true, "ph": true,
	"ae": true, "il": true, "tr": true, "it": true, "es": true, "pl": true, "ie": true,
	"fi": true, "no": true, "ca": true, "mx": true, "br": true, "ar": true, "cl": true,
}

func matchAlphaCode(name, code string, caseSensitive bool) bool {
	prefix := "(?i)"
	target := code
	if caseSensitive {
		prefix = ""
		target = strings.ToUpper(code)
	}
	re := regexp.MustCompile(fmt.Sprintf(`%s(?:^|[^a-zA-Z])%s(?:[^a-zA-Z]|$)`, prefix, regexp.QuoteMeta(target)))
	return re.MatchString(name)
}

func matchesKeywordList(name string, keywords []string, forceCaseSensitive bool) bool {
	lower := strings.ToLower(name)
	for _, raw := range keywords {
		kw := strings.TrimSpace(raw)
		if kw == "" {
			continue
		}
		if shortAlphaCode.MatchString(kw) {
			cs := forceCaseSensitive || caseSensitiveShortCodes[strings.ToLower(kw)]
			if matchAlphaCode(name, kw, cs) {
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
			return matchesKeywordList(name, list, false)
		}
	}
	def, ok := regionDefinitions[code]
	if !ok {
		return false
	}
	if matchesKeywordList(name, def.terms, false) {
		return true
	}
	if matchesKeywordList(name, def.codes, false) {
		return true
	}
	return matchesKeywordList(name, def.upperCodes, true)
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
