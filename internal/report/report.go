package report

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"mihomo-speedtest/internal/tester"
)

type SpeedRankPayload struct {
	GeneratedAt     string              `json:"generatedAt"`
	SortBy          string              `json:"sortBy"`
	TotalNodes      int                 `json:"totalNodes"`
	OkNodes         int                 `json:"okNodes"`
	TopNodeName     *string             `json:"topNodeName"`
	TopAvgSpeedMBps float64             `json:"topAvgSpeedMBps"`
	Results         []tester.NodeResult `json:"results"`
}

type HistorySummary struct {
	ID              string  `json:"id"`
	GeneratedAt     string  `json:"generatedAt"`
	SortBy          string  `json:"sortBy"`
	TotalNodes      int     `json:"totalNodes"`
	OkNodes         int     `json:"okNodes"`
	TopNodeName     *string `json:"topNodeName"`
	TopAvgSpeedMBps float64 `json:"topAvgSpeedMBps"`
}

func SortResults(results []tester.NodeResult, sortBy string) []tester.NodeResult {
	out := make([]tester.NodeResult, len(results))
	copy(out, results)

	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		var va, vb float64
		switch sortBy {
		case "steady":
			va, vb = a.SteadySpeedMBps, b.SteadySpeedMBps
		case "value":
			va, vb = a.ValueScore, b.ValueScore
		default:
			va, vb = a.AvgSpeedMBps, b.AvgSpeedMBps
		}
		if va != vb {
			return va > vb
		}
		la, lb := math.MaxInt32, math.MaxInt32
		if a.LatencyMs != nil {
			la = *a.LatencyMs
		}
		if b.LatencyMs != nil {
			lb = *b.LatencyMs
		}
		return la < lb
	})
	return out
}

func SaveSpeedRank(sortedResults []tester.NodeResult, outputPath, sortBy string) error {
	dir := filepath.Dir(outputPath)
	historyDir := filepath.Join(dir, "history")
	if err := os.MkdirAll(historyDir, 0o755); err != nil {
		return err
	}

	now := time.Now().UTC()
	okCount := 0
	var topName *string
	var topSpeed float64
	for _, r := range sortedResults {
		if r.Status == "OK" {
			okCount++
			if topName == nil && r.AvgSpeedMBps > 0 {
				nameCopy := r.Name
				topName = &nameCopy
				topSpeed = r.AvgSpeedMBps
			}
		}
	}

	payload := SpeedRankPayload{
		GeneratedAt:     now.Format(time.RFC3339Nano),
		SortBy:          sortBy,
		TotalNodes:      len(sortedResults),
		OkNodes:         okCount,
		TopNodeName:     topName,
		TopAvgSpeedMBps: topSpeed,
		Results:         sortedResults,
	}

	raw, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return err
	}
	raw = append(raw, '\n')
	if err := os.WriteFile(outputPath, raw, 0o644); err != nil {
		return err
	}

	stamp := strings.NewReplacer(":", "-", ".", "-").Replace(now.Format("2006-01-02T15-04-05.000Z"))
	historyPath := filepath.Join(historyDir, fmt.Sprintf("rank-%s.json", stamp))
	if err := os.WriteFile(historyPath, raw, 0o644); err != nil {
		return err
	}

	entries, err := os.ReadDir(historyDir)
	if err == nil {
		var files []string
		for _, e := range entries {
			if !e.IsDir() && strings.HasPrefix(e.Name(), "rank-") && strings.HasSuffix(e.Name(), ".json") {
				files = append(files, e.Name())
			}
		}
		sort.Sort(sort.Reverse(sort.StringSlice(files)))
		if len(files) > 30 {
			for _, old := range files[30:] {
				_ = os.Remove(filepath.Join(historyDir, old))
			}
		}
	}
	return nil
}

func ListHistorySnapshots(historyDir string) []HistorySummary {
	entries, err := os.ReadDir(historyDir)
	if err != nil {
		return []HistorySummary{}
	}
	var files []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasPrefix(e.Name(), "rank-") && strings.HasSuffix(e.Name(), ".json") {
			files = append(files, e.Name())
		}
	}
	sort.Sort(sort.Reverse(sort.StringSlice(files)))

	items := make([]HistorySummary, 0, len(files))
	for _, f := range files {
		b, err := os.ReadFile(filepath.Join(historyDir, f))
		if err != nil {
			continue
		}
		var data SpeedRankPayload
		if err := json.Unmarshal(b, &data); err != nil {
			continue
		}
		items = append(items, HistorySummary{
			ID:              strings.TrimSuffix(f, ".json"),
			GeneratedAt:     data.GeneratedAt,
			SortBy:          data.SortBy,
			TotalNodes:      data.TotalNodes,
			OkNodes:         data.OkNodes,
			TopNodeName:     data.TopNodeName,
			TopAvgSpeedMBps: data.TopAvgSpeedMBps,
		})
	}
	return items
}

func LoadHistorySnapshot(historyDir, id string) (SpeedRankPayload, error) {
	clean := filepath.Base(id)
	if clean == "" || clean == "." || strings.Contains(clean, "..") {
		return SpeedRankPayload{}, fmt.Errorf("无效的历史记录 ID")
	}
	b, err := os.ReadFile(filepath.Join(historyDir, clean+".json"))
	if err != nil {
		return SpeedRankPayload{}, err
	}
	var data SpeedRankPayload
	if err := json.Unmarshal(b, &data); err != nil {
		return SpeedRankPayload{}, err
	}
	return data, nil
}
