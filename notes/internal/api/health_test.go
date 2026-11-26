package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"sync"
	"testing"

	"github.com/gabrielassisxyz/houston/notes/internal/config"
	"github.com/gabrielassisxyz/houston/notes/internal/graph/testutil"
	"github.com/gabrielassisxyz/houston/notes/internal/vault"
	"github.com/gabrielassisxyz/houston/notes/internal/vault/reconcile"
)

type healthDoc struct {
	Status     string         `json:"status"`
	VaultRoot  string         `json:"vaultRoot"`
	VaultLabel string         `json:"vaultLabel"`
	Indexing   *bool          `json:"indexing"`
	Reports    map[string]int `json:"reports"`
}

type fixedStatus vault.Status

func (f fixedStatus) Status() vault.Status { return vault.Status(f) }

func TestHealthWithoutAVaultServiceKeepsItsThreeFields(t *testing.T) {
	mux := newTestRouter(t, newTestDeps(t, ""))
	var doc map[string]any
	getJSON(t, mux, "/api/health", &doc)
	var keys []string
	for k := range doc {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	if want := []string{"status", "vaultLabel", "vaultRoot"}; !reflect.DeepEqual(keys, want) {
		t.Errorf("health fields = %v, want %v", keys, want)
	}
}

func TestHealthReportsIndexingAndTheReportCounts(t *testing.T) {
	d := newTestDeps(t, "")
	d.Vault = fixedStatus{Indexing: true, Reports: map[reconcile.ReportKind]int{
		reconcile.ReportDuplicateID:       2,
		reconcile.ReportEmptyFile:         1,
		reconcile.ReportInvalidUTF8:       0,
		reconcile.ReportUnknownPermission: 3,
	}}
	var doc healthDoc
	getJSON(t, newTestRouter(t, d), "/api/health", &doc)
	if doc.Status != "ok" || doc.VaultRoot != d.VaultRoot {
		t.Errorf("the three fields changed: %+v", doc)
	}
	if doc.Indexing == nil || !*doc.Indexing {
		t.Errorf("indexing = %v, want true", doc.Indexing)
	}
	want := map[string]int{"duplicate_id": 2, "empty_file": 1, "invalid_utf8": 0, "unknown_permission": 3}
	if !reflect.DeepEqual(doc.Reports, want) {
		t.Errorf("reports = %v, want %v", doc.Reports, want)
	}
}

// Health is served while the vault service runs its first index, read from
// another goroutine on every request; run under -race. It says indexing until
// the index returns, then the counts of what the index skipped.
func TestHealthReadsTheVaultServiceDuringItsFirstIndex(t *testing.T) {
	root := t.TempDir()
	for i := 0; i < 200; i++ {
		writeVaultFile(t, root, fmt.Sprintf("notes/n%03d.md", i), fmt.Sprintf("# Note %d\n", i))
	}
	writeVaultFile(t, root, "placeholder.md", "")
	if err := os.WriteFile(filepath.Join(root, "latin1.md"), []byte{0x63, 0x61, 0x66, 0xe9, '\n'}, 0o644); err != nil {
		t.Fatal(err)
	}
	g := testutil.NewTestGraph(t)
	cfg := config.VaultConfig{Root: root}
	vault.ApplyDefaults(&cfg)
	svc := vault.New(g, cfg)
	t.Cleanup(svc.Stop)
	mux := newTestRouter(t, Deps{Graph: g, VaultRoot: root, Vault: svc})

	var before healthDoc
	getJSON(t, mux, "/api/health", &before)
	if before.Indexing == nil || !*before.Indexing {
		t.Fatalf("before the first index, indexing = %v, want true", before.Indexing)
	}

	started := make(chan error, 1)
	go func() { started <- svc.Start(context.Background()) }()
	var polls sync.WaitGroup
	polls.Add(1)
	stop := make(chan struct{})
	go func() {
		defer polls.Done()
		for {
			select {
			case <-stop:
				return
			default:
				// Not getJSON: t.Fatal must not run off the test's goroutine.
				w := httptest.NewRecorder()
				mux.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/health", nil))
				var doc healthDoc
				if err := json.Unmarshal(w.Body.Bytes(), &doc); err != nil || w.Code != http.StatusOK ||
					doc.Indexing == nil || doc.Reports == nil {
					t.Errorf("a health answer during the index lacks readiness: %d %s", w.Code, w.Body.String())
					return
				}
			}
		}
	}()
	if err := <-started; err != nil {
		t.Fatalf("Start: %v", err)
	}
	close(stop)
	polls.Wait()

	var after healthDoc
	getJSON(t, mux, "/api/health", &after)
	if after.Indexing == nil || *after.Indexing {
		t.Errorf("after the first index, indexing = %v, want false", after.Indexing)
	}
	if after.Reports["empty_file"] != 1 || after.Reports["invalid_utf8"] != 1 {
		t.Errorf("reports = %v, want one empty file and one invalid UTF-8 file", after.Reports)
	}
}
