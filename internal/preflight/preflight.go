package preflight

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

type VPNCheckResult struct {
	Detected     bool               `json:"detected"`
	Processes    []string           `json:"processes"`
	Ports        []int              `json:"ports"`
	SystemProxy  bool               `json:"systemProxy"`
	EnvProxy     bool               `json:"envProxy"`
	AutoClosable []SupportedVPNItem `json:"autoClosable"`
	Warnings     []string           `json:"warnings"`
	Message      string             `json:"message"`
}

func isLocalPortListening(port int) bool {
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 120*time.Millisecond)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

func detectWindowsSystemProxy() bool {
	if runtime.GOOS != "windows" {
		return false
	}
	cmd := exec.Command("reg", "query", `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`, "/v", "ProxyEnable")
	out, err := cmd.Output()
	if err != nil {
		return false
	}
	text := strings.ToLower(string(out))
	return strings.Contains(text, "0x1")
}

func detectWindowsVPNProcesses() []string {
	if runtime.GOOS != "windows" {
		return nil
	}
	known := []struct {
		exe   string
		label string
	}{
		{"clash verge.exe", "Clash Verge"},
		{"verge-mihomo.exe", "Clash Verge (内核)"},
		{"mihomo-party.exe", "Mihomo Party"},
		{"clash nyanpasu.exe", "Clash Nyanpasu"},
		{"flclash.exe", "FlClash"},
		{"flclashcore.exe", "FlClash (内核)"},
		{"clash for windows.exe", "Clash for Windows"},
		{"v2rayn.exe", "v2rayN"},
		{"nekoray.exe", "Nekoray"},
		{"nekobox.exe", "NekoBox"},
		{"hiddify.exe", "Hiddify"},
		{"sing-box.exe", "sing-box"},
	}

	cmd := exec.Command("tasklist", "/FO", "CSV", "/NH")
	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	lowerOut := strings.ToLower(string(out))
	seen := make(map[string]bool)
	var found []string
	for _, k := range known {
		if strings.Contains(lowerOut, `"`+k.exe+`"`) && !seen[k.label] {
			seen[k.label] = true
			found = append(found, k.label)
		}
	}
	return found
}

// DetectRunningVPN 检测本机是否正在运行常见 VPN 客户端、代理端口或系统代理。
func DetectRunningVPN() VPNCheckResult {
	res := VPNCheckResult{
		Processes: []string{},
		Ports:     []int{},
		Warnings:  []string{},
	}

	if procs := detectWindowsVPNProcesses(); len(procs) > 0 {
		res.Processes = procs
		res.Warnings = append(res.Warnings, fmt.Sprintf("检测到 VPN 客户端进程: %s", strings.Join(procs, "、")))
	}

	commonPorts := []struct {
		port int
		name string
	}{
		{7890, "Clash 默认代理端口 (7890)"},
		{7897, "Clash Verge 代理端口 (7897)"},
		{10808, "v2rayN SOCKS 端口 (10808)"},
		{10809, "v2rayN HTTP 端口 (10809)"},
		{2080, "Nekoray 代理端口 (2080)"},
		{9097, "Clash Verge 控制端口 (9097)"},
	}
	var portLabels []string
	for _, p := range commonPorts {
		if isLocalPortListening(p.port) {
			res.Ports = append(res.Ports, p.port)
			portLabels = append(portLabels, p.name)
		}
	}
	if len(portLabels) > 0 {
		res.Warnings = append(res.Warnings, fmt.Sprintf("检测到本地代理端口占用: %s", strings.Join(portLabels, "、")))
	}

	if detectWindowsSystemProxy() {
		res.SystemProxy = true
		res.Warnings = append(res.Warnings, "检测到 Windows 系统代理已开启")
	}

	for _, envKey := range []string{"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"} {
		val := strings.TrimSpace(os.Getenv(envKey))
		if val == "" {
			continue
		}
		if !strings.Contains(val, "://") {
			val = "http://" + val
		}
		u, err := url.Parse(val)
		if err != nil {
			res.EnvProxy = true
			break
		}
		host := strings.ToLower(u.Hostname())
		portStr := u.Port()
		// 若指向本地回环地址且有端口，则探测该端口是否真的存活；若端口已关闭说明只是终端残留环境变量，不误报
		if (host == "127.0.0.1" || host == "localhost" || host == "::1") && portStr != "" {
			if p, err := strconv.Atoi(portStr); err == nil && p > 0 {
				conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", p), 200*time.Millisecond)
				if err != nil {
					continue
				}
				_ = conn.Close()
			}
		}
		res.EnvProxy = true
		break
	}
	if res.EnvProxy {
		res.Warnings = append(res.Warnings, "检测到终端环境变量代理 (HTTP_PROXY/HTTPS_PROXY)")
	}

	res.AutoClosable = InspectActiveSupportedVPNs()
	res.Detected = len(res.Processes) > 0 || len(res.Ports) > 0 || res.SystemProxy || res.EnvProxy
	if res.Detected {
		res.Message = "检测到本机可能正在运行 VPN 软件或已开启系统代理，建议根据情况先关闭（尤其是 TUN 模式）后再测速，避免影响测速准确性。"
	} else {
		res.Message = "未检测到常见 VPN 软件或系统代理运行，可直接开始测速（如开启了其他 TUN 虚拟网卡，请先关闭）。"
	}
	return res
}

func IsPortAvailable(port int) bool {
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		return false
	}
	_ = ln.Close()
	return true
}

func FindAvailablePort(startPort int, exclude map[int]bool) (int, error) {
	for port := startPort; port <= 65535; port++ {
		if exclude != nil && exclude[port] {
			continue
		}
		if IsPortAvailable(port) {
			return port, nil
		}
	}
	return 0, fmt.Errorf("从端口 %d 起未找到可用端口", startPort)
}

func ResolvePorts(mixedStart, controllerStart int) (int, int, error) {
	mixedPort, err := FindAvailablePort(mixedStart, nil)
	if err != nil {
		return 0, 0, err
	}
	controllerPort, err := FindAvailablePort(controllerStart, map[int]bool{mixedPort: true})
	if err != nil {
		return 0, 0, err
	}
	return mixedPort, controllerPort, nil
}

// ResolveWorkerPorts 为并发测速分配 N 个不冲突的 Worker 端口和 1 个 Controller 端口。
func ResolveWorkerPorts(mixedStart, controllerStart, concurrency int) ([]int, int, error) {
	if concurrency < 1 {
		concurrency = 1
	}
	if concurrency > 16 {
		concurrency = 16
	}
	used := make(map[int]bool)
	workerPorts := make([]int, 0, concurrency)
	nextStart := mixedStart
	for i := 0; i < concurrency; i++ {
		p, err := FindAvailablePort(nextStart, used)
		if err != nil {
			return nil, 0, err
		}
		used[p] = true
		workerPorts = append(workerPorts, p)
		nextStart = p + 1
	}
	controllerPort, err := FindAvailablePort(controllerStart, used)
	if err != nil {
		return nil, 0, err
	}
	return workerPorts, controllerPort, nil
}

func DefaultMihomoCandidates() []string {
	if runtime.GOOS != "windows" {
		return []string{"/usr/local/bin/mihomo", "/usr/bin/mihomo"}
	}
	localAppData := os.Getenv("LOCALAPPDATA")
	candidates := []string{
		`C:\Program Files\Clash Verge\verge-mihomo.exe`,
		`C:\Program Files\Clash Verge\mihomo.exe`,
	}
	if localAppData != "" {
		candidates = append(candidates,
			filepath.Join(localAppData, "Programs", "Clash Verge", "verge-mihomo.exe"),
			filepath.Join(localAppData, "Programs", "Clash Verge", "mihomo.exe"),
		)
	}
	return candidates
}

func EnsureMihomoBinary(binDir string) (string, error) {
	binName := "mihomo"
	if runtime.GOOS == "windows" {
		binName = "mihomo.exe"
	}
	target := filepath.Join(binDir, binName)
	if info, err := os.Stat(target); err == nil && !info.IsDir() {
		return target, nil
	}

	candidates := DefaultMihomoCandidates()
	for _, c := range candidates {
		if info, err := os.Stat(c); err == nil && !info.IsDir() {
			return c, nil
		}
	}

	return "", fmt.Errorf(
		"未找到 Mihomo 内核 (%s)。\n已扫描以下常见路径均未找到:\n  - %s\n请将 %s 放入 bin/ 目录后重试",
		target,
		strings.Join(candidates, "\n  - "),
		binName,
	)
}
