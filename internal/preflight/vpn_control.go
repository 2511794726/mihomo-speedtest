package preflight

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// SupportedVPNItem 描述可安全自动退出并按原路径恢复的白名单 VPN 客户端。
type SupportedVPNItem struct {
	Name        string `json:"name"`
	ProcessName string `json:"processName"`
	ExePath     string `json:"exePath"`
	PID         int    `json:"pid,omitempty"`
}

type vpnWhitelistSpec struct {
	DisplayName string
	SubCores    []string
}

var supportedVPNWhitelist = map[string]vpnWhitelistSpec{
	"clash-verge.exe":       {DisplayName: "Clash Verge", SubCores: []string{"verge-mihomo.exe", "verge-mihomo-alpha.exe"}},
	"mihomo-party.exe":      {DisplayName: "Mihomo Party", SubCores: []string{"mihomo.exe", "mihomo-alpha.exe"}},
	"clash-nyanpasu.exe":    {DisplayName: "Clash Nyanpasu", SubCores: []string{"mihomo.exe", "nyanpasu-mihomo.exe"}},
	"flclash.exe":           {DisplayName: "FlClash", SubCores: []string{"flclashcore.exe", "mihomo.exe"}},
	"clash for windows.exe": {DisplayName: "Clash for Windows", SubCores: []string{"clash-win64.exe"}},
	"v2rayn.exe":            {DisplayName: "v2rayN", SubCores: []string{"xray.exe", "sing-box.exe", "v2ray.exe"}},
	"nekoray.exe":           {DisplayName: "NekoRay", SubCores: []string{"nekobox_core.exe", "sing-box.exe"}},
	"nekobox.exe":           {DisplayName: "NekoBox", SubCores: []string{"nekobox_core.exe", "sing-box.exe"}},
}

// InspectActiveSupportedVPNs 查询当前正在运行且处于白名单中的 VPN 主程序及其可执行文件路径。
func InspectActiveSupportedVPNs() []SupportedVPNItem {
	if runtime.GOOS != "windows" {
		return []SupportedVPNItem{}
	}
	script := `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath } | Select-Object ProcessId, Name, ExecutablePath | ConvertTo-Json -Compress`
	out, err := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command", script).Output()
	if err != nil {
		return []SupportedVPNItem{}
	}
	raw := strings.TrimSpace(string(out))
	if raw == "" {
		return []SupportedVPNItem{}
	}

	type procRow struct {
		ProcessID      int    `json:"ProcessId"`
		Name           string `json:"Name"`
		ExecutablePath string `json:"ExecutablePath"`
	}
	var rows []procRow
	if strings.HasPrefix(raw, "[") {
		_ = json.Unmarshal([]byte(raw), &rows)
	} else if strings.HasPrefix(raw, "{") {
		var single procRow
		if err := json.Unmarshal([]byte(raw), &single); err == nil {
			rows = append(rows, single)
		}
	}

	seen := make(map[string]bool)
	items := make([]SupportedVPNItem, 0)
	for _, row := range rows {
		lower := strings.ToLower(strings.TrimSpace(row.Name))
		spec, ok := supportedVPNWhitelist[lower]
		if !ok || strings.TrimSpace(row.ExecutablePath) == "" {
			continue
		}
		if seen[lower] {
			continue
		}
		seen[lower] = true
		items = append(items, SupportedVPNItem{
			Name:        spec.DisplayName,
			ProcessName: row.Name,
			ExePath:     row.ExecutablePath,
			PID:         row.ProcessID,
		})
	}
	return items
}

func disableWindowsSystemProxy() {
	if runtime.GOOS != "windows" {
		return
	}
	_ = exec.Command("reg", "add", `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`, "/v", "ProxyEnable", "/t", "REG_DWORD", "/d", "0", "/f").Run()
}

// ShutdownSupportedVPNs 安全关闭白名单 VPN：先复位系统代理，再结束主程序与关联内核，返回已关闭列表（含启动路径）。
func ShutdownSupportedVPNs() ([]SupportedVPNItem, error) {
	if runtime.GOOS != "windows" {
		return nil, errors.New("当前系统暂不支持自动退出 VPN，请手动关闭后再测速")
	}
	active := InspectActiveSupportedVPNs()
	if len(active) == 0 {
		return []SupportedVPNItem{}, nil
	}

	// 1. 先安全关闭系统代理，避免强杀后系统代理残留导致断网
	disableWindowsSystemProxy()

	// 2. 收集需要清理的主进程名与关联内核名
	procNames := make([]string, 0, len(active)*2)
	seenProc := make(map[string]bool)
	for _, item := range active {
		lower := strings.ToLower(item.ProcessName)
		if !seenProc[lower] {
			seenProc[lower] = true
			procNames = append(procNames, item.ProcessName)
		}
		if spec, ok := supportedVPNWhitelist[lower]; ok {
			for _, sub := range spec.SubCores {
				subLower := strings.ToLower(sub)
				if !seenProc[subLower] {
					seenProc[subLower] = true
					procNames = append(procNames, sub)
				}
			}
		}
	}

	for _, pname := range procNames {
		_ = exec.Command("taskkill", "/IM", pname, "/F", "/T").Run()
	}

	// 3. 等待进程释放并复检
	time.Sleep(600 * time.Millisecond)
	stillAlive := InspectActiveSupportedVPNs()
	if len(stillAlive) > 0 {
		names := make([]string, 0, len(stillAlive))
		for _, s := range stillAlive {
			names = append(names, s.Name)
		}
		return nil, fmt.Errorf("无法自动退出 %s（可能以管理员权限运行或开启了系统服务），请手动右键托盘退出后再试", strings.Join(names, "、"))
	}

	return active, nil
}

// LaunchVPNByPath 根据保存的可执行文件路径重新启动 VPN 客户端。
func LaunchVPNByPath(exePath string) error {
	if runtime.GOOS != "windows" {
		return errors.New("当前系统暂不支持自动启动 VPN")
	}
	cleaned := strings.TrimSpace(exePath)
	if cleaned == "" {
		return errors.New("未提供有效的 VPN 程序路径")
	}
	if strings.ToLower(filepath.Ext(cleaned)) != ".exe" {
		return errors.New("非法的程序路径，仅允许启动 .exe 客户端")
	}
	info, err := os.Stat(cleaned)
	if err != nil || info.IsDir() {
		return fmt.Errorf("未找到 VPN 程序文件: %s", cleaned)
	}

	// 校验文件名属于白名单，避免任意执行风险
	base := strings.ToLower(filepath.Base(cleaned))
	if _, ok := supportedVPNWhitelist[base]; !ok {
		return errors.New("该程序不在支持的 VPN 白名单内，请手动打开")
	}

	cmd := exec.Command(cleaned)
	cmd.Dir = filepath.Dir(cleaned)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("启动 VPN 失败: %w", err)
	}
	return nil
}
