//go:build !windows

package mihomo

import "os/exec"

func hideWindow(_ *exec.Cmd) {}
