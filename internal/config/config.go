package config

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

type Settings struct {
	SubscribeURL       string   `json:"subscribeUrl"`
	UserAgents         []string `json:"userAgents"`
	MixedPort          int      `json:"mixedPort"`
	ControllerPort     int      `json:"controllerPort"`
	ControllerSecret   string   `json:"controllerSecret"`
	TestURL            string   `json:"testUrl"`
	MaxBytesPerNode    int64    `json:"maxBytesPerNode"`
	DownloadTimeoutMs  int      `json:"downloadTimeoutMs"`
	LatencyTimeoutMs   int      `json:"latencyTimeoutMs"`
	ExcludeKeywords    []string `json:"excludeKeywords"`
	IncludeRegions     []string            `json:"includeRegions"`
	IncludeKeywords    []string            `json:"includeKeywords"`
	RegionKeywords     map[string][]string `json:"regionKeywords"`
	ClashVergeAPI      string              `json:"clashVergeApi"`
	ClashVergeSecret   string   `json:"clashVergeSecret"`
	ClashVergeSelector string   `json:"clashVergeSelector"`
	AutoApplyTopNode   bool     `json:"autoApplyTopNode"`
	EnableUnlockCheck  bool     `json:"enableUnlockCheck"`
	Concurrency        int      `json:"concurrency"`
	MaxBandwidthMBps   float64  `json:"maxBandwidthMBps"`
}

func DefaultSettings() Settings {
	return Settings{
		SubscribeURL: "https://example.com/api/v1/client/subscribe?token=YOUR_TOKEN",
		UserAgents: []string{
			"ClashVerge/2.0.0",
			"ClashMetaForAndroid/2.11.2",
			"v2rayN/7.25.0",
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
		},
		MixedPort:         17890,
		ControllerPort:    19090,
		ControllerSecret:  "speedtest-secret",
		TestURL:           "https://speed.cloudflare.com/__down?bytes=25000000",
		MaxBytesPerNode:   10485760,
		DownloadTimeoutMs: 8000,
		LatencyTimeoutMs:  3000,
		ExcludeKeywords:   []string{"官网", "公告", "剩余流量", "套餐到期", "重置", "订阅", "网址"},
		IncludeRegions:    []string{},
		IncludeKeywords:   []string{},
		RegionKeywords:    map[string][]string{},
		ClashVergeAPI:     "http://127.0.0.1:9097",
		ClashVergeSecret:  "",
		ClashVergeSelector: "",
		AutoApplyTopNode:  false,
		EnableUnlockCheck: false,
		Concurrency:       2,
		MaxBandwidthMBps:  0,
	}
}

func LoadSettings(settingsPath string) (Settings, bool, error) {
	def := DefaultSettings()
	data, err := os.ReadFile(settingsPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			if mkErr := os.MkdirAll(filepath.Dir(settingsPath), 0o755); mkErr != nil {
				return def, false, mkErr
			}
			if saveErr := SaveSettings(settingsPath, def); saveErr != nil {
				return def, false, saveErr
			}
			return def, true, nil
		}
		return def, false, err
	}

	merged := def
	if err := json.Unmarshal(data, &merged); err != nil {
		return def, false, err
	}
	if len(merged.UserAgents) == 0 {
		merged.UserAgents = def.UserAgents
	}
	if merged.MixedPort == 0 {
		merged.MixedPort = def.MixedPort
	}
	if merged.ControllerPort == 0 {
		merged.ControllerPort = def.ControllerPort
	}
	if merged.MaxBytesPerNode <= 0 {
		merged.MaxBytesPerNode = def.MaxBytesPerNode
	}
	if merged.DownloadTimeoutMs <= 0 {
		merged.DownloadTimeoutMs = def.DownloadTimeoutMs
	}
	if merged.LatencyTimeoutMs <= 0 {
		merged.LatencyTimeoutMs = def.LatencyTimeoutMs
	}
	if merged.Concurrency <= 0 {
		merged.Concurrency = def.Concurrency
	}
	if merged.Concurrency > 16 {
		merged.Concurrency = 16
	}
	if merged.MaxBandwidthMBps < 0 {
		merged.MaxBandwidthMBps = 0
	}
	return merged, false, nil
}

func SaveSettings(settingsPath string, s Settings) error {
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(settingsPath, append(data, '\n'), 0o644)
}
