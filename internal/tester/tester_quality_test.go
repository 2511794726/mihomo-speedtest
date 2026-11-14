package tester

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"mihomo-speedtest/internal/config"
)

func intPtr(v int) *int {
	return &v
}

func TestComputeLatencyStats(t *testing.T) {
	median, jitter, loss := computeLatencyStats([]*int{intPtr(100), intPtr(120), intPtr(110)})
	if median == nil || *median != 110 {
		t.Fatalf("expected median 110, got %v", median)
	}
	if jitter == nil || *jitter != 15 {
		t.Fatalf("expected jitter 15, got %v", jitter)
	}
	if loss == nil || *loss != 0 {
		t.Fatalf("expected loss 0, got %v", loss)
	}

	median2, jitter2, loss2 := computeLatencyStats([]*int{intPtr(80), nil, intPtr(100)})
	if median2 == nil || *median2 != 100 {
		t.Fatalf("expected median 100, got %v", median2)
	}
	if jitter2 == nil || *jitter2 != 20 {
		t.Fatalf("expected jitter 20, got %v", jitter2)
	}
	if loss2 == nil || *loss2 != 33.3 {
		t.Fatalf("expected loss 33.3, got %v", loss2)
	}
}

func TestClassifyIPType(t *testing.T) {
	if got := classifyIPType(true, false); got != "datacenter" {
		t.Fatalf("expected datacenter, got %s", got)
	}
	if got := classifyIPType(false, true); got != "mobile" {
		t.Fatalf("expected mobile, got %s", got)
	}
	if got := classifyIPType(false, false); got != "residential" {
		t.Fatalf("expected residential, got %s", got)
	}
}

func TestPickFallbackTestURL(t *testing.T) {
	primary := "https://speed.cloudflare.com/__down?bytes=25000000"
	fb := pickFallbackTestURL(primary)
	if fb == "" || fb == primary {
		t.Fatalf("expected different fallback url, got %q", fb)
	}
}

func TestMultiStreamDownloadBreaksSingleStreamCap(t *testing.T) {
	// 模拟单条连接被服务端限速在 ~160 KB/s，验证 4 路并发拉流能够突破单流限速且按 maxBytesPerNode 熔断
	chunk := make([]byte, 16*1024)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		flusher, _ := w.(http.Flusher)
		for i := 0; i < 60; i++ {
			select {
			case <-r.Context().Done():
				return
			default:
			}
			_, err := w.Write(chunk)
			if err != nil {
				return
			}
			if flusher != nil {
				flusher.Flush()
			}
			time.Sleep(100 * time.Millisecond)
		}
	}))
	defer srv.Close()

	tr1 := &http.Transport{}
	defer tr1.CloseIdleConnections()
	ok1, bytes1, avg1, _, _, err1 := runMultiStreamWithTransport(context.Background(), tr1, srv.URL, 600*1024, 1500, 1.0, nil, 1)
	if !ok1 && bytes1 == 0 {
		t.Fatalf("single stream failed unexpectedly: %s", err1)
	}

	tr4 := &http.Transport{MaxIdleConnsPerHost: 8}
	defer tr4.CloseIdleConnections()
	ok4, bytes4, avg4, _, _, err4 := runMultiStreamWithTransport(context.Background(), tr4, srv.URL, 700*1024, 2500, 1.0, nil, 4)
	if !ok4 {
		t.Fatalf("multi stream failed: %s", err4)
	}
	if bytes4 < 700*1024 {
		t.Fatalf("expected >= 700KB total bytes on cap abort, got %d", bytes4)
	}
	if avg4 <= avg1*2.0 {
		t.Fatalf("expected 4-stream speed (%v MB/s) > 2x single-stream (%v MB/s)", avg4, avg1)
	}
}

func floatPtr(v float64) *float64 {
	return &v
}

func TestCompositeValueScorePenalties(t *testing.T) {
	clean := ComputeCompositeValueScore(20, 15, 1.0, intPtr(50), intPtr(10), floatPtr(0))
	if clean != 20 {
		t.Fatalf("expected clean score 20, got %v", clean)
	}
	highLat := ComputeCompositeValueScore(20, 15, 1.0, intPtr(280), intPtr(10), floatPtr(0))
	if highLat >= clean {
		t.Fatalf("expected high latency score (%v) < clean (%v)", highLat, clean)
	}
	lossy := ComputeCompositeValueScore(20, 15, 1.0, intPtr(50), intPtr(10), floatPtr(20))
	if lossy >= clean*0.6 {
		t.Fatalf("expected 20%% loss score (%v) < 60%% of clean (%v)", lossy, clean)
	}
	highMult := ComputeCompositeValueScore(20, 15, 2.0, intPtr(50), intPtr(10), floatPtr(0))
	if highMult != 10 {
		t.Fatalf("expected 2x multiplier score 10, got %v", highMult)
	}
}

func TestResolveEffectiveMaxBytes(t *testing.T) {
	s := config.DefaultSettings()
	if got := ResolveEffectiveMaxBytes(s); got != 10485760 {
		t.Fatalf("expected default 10MB when localSteadyMBps=0, got %d", got)
	}

	s.LocalSteadyMBps = 15.0 // 15 * 4 = 60MB
	if got := ResolveEffectiveMaxBytes(s); got != 60*1024*1024 {
		t.Fatalf("expected 60MB adaptive cap, got %d", got)
	}

	s.LocalSteadyMBps = 120.0 // 120 * 4 = 480MB -> capped at 100MB
	if got := ResolveEffectiveMaxBytes(s); got != 100*1024*1024 {
		t.Fatalf("expected 100MB max cap, got %d", got)
	}
}
