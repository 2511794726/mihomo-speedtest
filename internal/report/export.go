package report

import (
	"fmt"
	"os"

	"gopkg.in/yaml.v3"
)

// BuildOptimizedClashYAML 从 runtimeYAMLPath 提取指定节点定义，生成仅包含优选节点与自动测速组的精简 Clash YAML。
func BuildOptimizedClashYAML(runtimeYAMLPath string, targetNames []string) (string, int, error) {
	if len(targetNames) == 0 {
		return "", 0, fmt.Errorf("没有可导出的可用节点")
	}

	raw, err := os.ReadFile(runtimeYAMLPath)
	if err != nil {
		return "", 0, fmt.Errorf("未找到运行时订阅配置 (%s)，请先执行一次测速或预览", runtimeYAMLPath)
	}

	var parsed map[string]any
	if err := yaml.Unmarshal(raw, &parsed); err != nil {
		return "", 0, fmt.Errorf("解析运行时 YAML 失败: %w", err)
	}

	rawProxies, ok := parsed["proxies"].([]any)
	if !ok || len(rawProxies) == 0 {
		return "", 0, fmt.Errorf("当前订阅采用远程 proxy-providers 模式或未包含内联 proxies 列表，暂不支持直接导出精简 YAML")
	}

	proxyByName := make(map[string]map[string]any, len(rawProxies))
	for _, item := range rawProxies {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		name, _ := m["name"].(string)
		if name != "" {
			proxyByName[name] = m
		}
	}

	selectedProxies := make([]map[string]any, 0, len(targetNames))
	selectedNames := make([]string, 0, len(targetNames))
	for _, name := range targetNames {
		if p, exists := proxyByName[name]; exists {
			selectedProxies = append(selectedProxies, p)
			selectedNames = append(selectedNames, name)
		}
	}
	if len(selectedProxies) == 0 {
		return "", 0, fmt.Errorf("未能从当前订阅配置中匹配到优选节点（可能订阅已更新，请重新测速）")
	}

	selectGroupProxies := append([]string{"♻️ 自动优选", "🔯 故障转移"}, selectedNames...)

	outConfig := map[string]any{
		"mixed-port":          7890,
		"allow-lan":           false,
		"mode":                "rule",
		"log-level":           "info",
		"unified-delay":       true,
		"external-controller": "127.0.0.1:9090",
		"proxies":             selectedProxies,
		"proxy-groups": []map[string]any{
			{
				"name":    "🚀 节点选择",
				"type":    "select",
				"proxies": selectGroupProxies,
			},
			{
				"name":      "♻️ 自动优选",
				"type":      "url-test",
				"url":       "http://www.gstatic.com/generate_204",
				"interval":  300,
				"tolerance": 50,
				"proxies":   selectedNames,
			},
			{
				"name":     "🔯 故障转移",
				"type":     "fallback",
				"url":      "http://www.gstatic.com/generate_204",
				"interval": 300,
				"proxies":  selectedNames,
			},
		},
		"rules": []string{
			"GEOIP,LAN,DIRECT",
			"GEOIP,CN,DIRECT",
			"MATCH,🚀 节点选择",
		},
	}

	outBytes, err := yaml.Marshal(outConfig)
	if err != nil {
		return "", 0, fmt.Errorf("序列化 YAML 失败: %w", err)
	}

	header := "# 由 Mihomo Speedtest 自动生成的精简优选配置文件\n# 仅保留测速优选节点，内置自动测速 (url-test) 与故障转移 (fallback)\n"
	return header + string(outBytes), len(selectedProxies), nil
}
