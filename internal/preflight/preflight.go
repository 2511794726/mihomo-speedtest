package preflight

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

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
