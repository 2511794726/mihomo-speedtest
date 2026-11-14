package subscribe

import (
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
	"mihomo-speedtest/internal/config"
)

var uriSchemeRegex = regexp.MustCompile(`(?i)(vless|hy2|hysteria2|trojan|ss|ssr|vmess|tuic|anytls)://`)

type SubInfo struct {
	Format          string
	RuntimeYAMLPath string
	HasProviders    bool
	Source          string
	UsedUserAgent   string
}

func decodeBase64Flexible(input string) string {
	norm := strings.TrimSpace(input)
	norm = strings.ReplaceAll(norm, "-", "+")
	norm = strings.ReplaceAll(norm, "_", "/")
	if rem := len(norm) % 4; rem != 0 {
		norm += strings.Repeat("=", 4-rem)
	}
	b, err := base64.StdEncoding.DecodeString(norm)
	if err != nil {
		return ""
	}
	return string(b)
}

func fetchRaw(subscribeURL string, userAgents []string, rawSavePath string) (string, string, string, error) {
	trimmed := strings.TrimSpace(subscribeURL)
	isRemote := strings.HasPrefix(strings.ToLower(trimmed), "http://") || strings.HasPrefix(strings.ToLower(trimmed), "https://")

	var rawText string
	var usedUA string
	source := "local"

	if !isRemote {
		b, err := os.ReadFile(trimmed)
		if err != nil {
			return "", "", "", err
		}
		rawText = string(b)
		if strings.TrimSpace(rawText) == "" {
			return "", "", "", fmt.Errorf("本地订阅文件为空: %s", trimmed)
		}
	} else {
		source = "remote"
		// 显式禁用系统代理环境变量
		client := &http.Client{
			Timeout: 15 * time.Second,
			Transport: &http.Transport{
				Proxy: nil,
			},
		}
		var errs []string
		for _, ua := range userAgents {
			req, err := http.NewRequest(http.MethodGet, trimmed, nil)
			if err != nil {
				errs = append(errs, err.Error())
				continue
			}
			req.Header.Set("User-Agent", ua)
			resp, err := client.Do(req)
			if err != nil {
				errs = append(errs, fmt.Sprintf("UA=%q -> %v", ua, err))
				continue
			}
			bodyBytes, readErr := io.ReadAll(resp.Body)
			_ = resp.Body.Close()
			if readErr != nil {
				errs = append(errs, fmt.Sprintf("UA=%q -> %v", ua, readErr))
				continue
			}
			body := string(bodyBytes)
			if resp.StatusCode == http.StatusOK && strings.TrimSpace(body) != "" {
				rawText = body
				usedUA = ua
				break
			}
			errs = append(errs, fmt.Sprintf("UA=%q -> HTTP %d", ua, resp.StatusCode))
		}
		if strings.TrimSpace(rawText) == "" {
			return "", "", "", fmt.Errorf("拉取在线订阅失败:\n  - %s", strings.Join(errs, "\n  - "))
		}
	}

	if err := os.MkdirAll(filepath.Dir(rawSavePath), 0o755); err != nil {
		return "", "", "", err
	}
	if err := os.WriteFile(rawSavePath, []byte(rawText), 0o644); err != nil {
		return "", "", "", err
	}
	return rawText, source, usedUA, nil
}

func ensureGlobalGroupWithProviders(existing any, providerNames []string) []any {
	var groups []any
	if list, ok := existing.([]any); ok {
		groups = append(groups, list...)
	}

	found := false
	for i, item := range groups {
		if m, ok := item.(map[string]any); ok {
			if name, _ := m["name"].(string); name == "GLOBAL" {
				m["type"] = "select"
				seen := map[string]bool{}
				var merged []string
				if oldUse, ok := m["use"].([]any); ok {
					for _, u := range oldUse {
						if s, ok := u.(string); ok && !seen[s] {
							seen[s] = true
							merged = append(merged, s)
						}
					}
				}
				for _, p := range providerNames {
					if !seen[p] {
						seen[p] = true
						merged = append(merged, p)
					}
				}
				m["use"] = merged
				groups[i] = m
				found = true
				break
			}
		}
	}
	if !found {
		groups = append([]any{map[string]any{
			"name": "GLOBAL",
			"type": "select",
			"use":  providerNames,
		}}, groups...)
	}
	return groups
}

func PrepareRuntimeSubscription(s config.Settings, mixedPort, controllerPort int, configsDir string) (SubInfo, error) {
	return PrepareRuntimeSubscriptionWithWorkers(s, []int{mixedPort}, controllerPort, configsDir)
}

func PrepareRuntimeSubscriptionWithWorkers(s config.Settings, workerPorts []int, controllerPort int, configsDir string) (SubInfo, error) {
	if len(workerPorts) == 0 {
		workerPorts = []int{s.MixedPort}
	}
	mixedPort := workerPorts[0]
	rawSavePath := filepath.Join(configsDir, "sub.raw")
	rawUrisPath := filepath.Join(configsDir, "raw-uris.txt")
	runtimeYAMLPath := filepath.Join(configsDir, "runtime.yaml")

	rawText, source, usedUA, err := fetchRaw(s.SubscribeURL, s.UserAgents, rawSavePath)
	if err != nil {
		return SubInfo{}, err
	}

	var parsed map[string]any
	_ = yaml.Unmarshal([]byte(rawText), &parsed)

	var format string
	var hasProviders bool
	baseConfig := map[string]any{}

	proxiesList, hasProxiesSlice := parsed["proxies"].([]any)
	providersMap, hasProvidersMap := parsed["proxy-providers"].(map[string]any)

	if parsed != nil && hasProxiesSlice && len(proxiesList) > 0 {
		format = "clash-yaml"
		for k, v := range parsed {
			baseConfig[k] = v
		}
		hasProviders = hasProvidersMap && len(providersMap) > 0
	} else if parsed != nil && hasProvidersMap && len(providersMap) > 0 {
		format = "proxy-providers"
		hasProviders = true
		for k, v := range parsed {
			baseConfig[k] = v
		}
		var names []string
		for k := range providersMap {
			names = append(names, k)
		}
		baseConfig["proxy-groups"] = ensureGlobalGroupWithProviders(parsed["proxy-groups"], names)
	} else {
		uriText := ""
		if uriSchemeRegex.MatchString(rawText) {
			uriText = strings.TrimSpace(rawText)
		} else {
			decoded := decodeBase64Flexible(rawText)
			if uriSchemeRegex.MatchString(decoded) {
				uriText = strings.TrimSpace(decoded)
			}
		}
		if uriText == "" {
			return SubInfo{}, fmt.Errorf("订阅格式无法识别：既不是有效的 Clash YAML，也不包含受支持的代理节点 URI")
		}
		format = "uri-list"
		hasProviders = true
		if err := os.WriteFile(rawUrisPath, []byte(uriText+"\n"), 0o644); err != nil {
			return SubInfo{}, err
		}
		baseConfig["proxy-providers"] = map[string]any{
			"sub-uris": map[string]any{
				"type": "file",
				"path": "./raw-uris.txt",
				"health-check": map[string]any{
					"enable": false,
				},
			},
		}
		baseConfig["proxy-groups"] = []any{
			map[string]any{
				"name": "GLOBAL",
				"type": "select",
				"use":  []string{"sub-uris"},
			},
		}
	}

	delete(baseConfig, "tun")
	delete(baseConfig, "external-ui")
	delete(baseConfig, "listeners")

	baseConfig["mixed-port"] = mixedPort
	baseConfig["allow-lan"] = false
	baseConfig["log-level"] = "warning"
	baseConfig["external-controller"] = fmt.Sprintf("127.0.0.1:%d", controllerPort)
	baseConfig["secret"] = s.ControllerSecret
	baseConfig["dns"] = map[string]any{
		"enable":        true,
		"enhanced-mode": "fake-ip",
		"fake-ip-range": "198.18.0.1/16",
		"nameserver":    []string{"223.5.5.5", "1.1.1.1"},
	}

	if len(workerPorts) > 1 {
		var proxyNames []string
		if plist, ok := baseConfig["proxies"].([]any); ok {
			for _, item := range plist {
				if m, ok := item.(map[string]any); ok {
					if name, ok := m["name"].(string); ok && name != "" {
						proxyNames = append(proxyNames, name)
					}
				}
			}
		}
		var providerNames []string
		if pmap, ok := baseConfig["proxy-providers"].(map[string]any); ok {
			for k := range pmap {
				providerNames = append(providerNames, k)
			}
		}

		groups, _ := baseConfig["proxy-groups"].([]any)
		listeners := make([]map[string]any, 0, len(workerPorts))
		rules := make([]string, 0, len(workerPorts)+1)

		for i, wp := range workerPorts {
			gName := fmt.Sprintf("SPEEDTEST_W%d", i)
			grp := map[string]any{
				"name": gName,
				"type": "select",
			}
			if len(proxyNames) > 0 {
				grp["proxies"] = proxyNames
			}
			if len(providerNames) > 0 {
				grp["use"] = providerNames
			}
			groups = append(groups, grp)
			listeners = append(listeners, map[string]any{
				"name":   fmt.Sprintf("st-in-%d", i),
				"type":   "mixed",
				"listen": "127.0.0.1",
				"port":   wp,
				"proxy":  gName,
			})
			rules = append(rules, fmt.Sprintf("IN-PORT,%d,%s", wp, gName))
		}
		rules = append(rules, "MATCH,GLOBAL")

		baseConfig["proxy-groups"] = groups
		baseConfig["listeners"] = listeners
		baseConfig["mode"] = "rule"
		baseConfig["rules"] = rules
	} else {
		baseConfig["mode"] = "global"
		baseConfig["rules"] = []string{"MATCH,GLOBAL"}
	}

	outBytes, err := yaml.Marshal(baseConfig)
	if err != nil {
		return SubInfo{}, err
	}
	if err := os.WriteFile(runtimeYAMLPath, outBytes, 0o644); err != nil {
		return SubInfo{}, err
	}

	return SubInfo{
		Format:          format,
		RuntimeYAMLPath: runtimeYAMLPath,
		HasProviders:    hasProviders,
		Source:          source,
		UsedUserAgent:   usedUA,
	}, nil
}
