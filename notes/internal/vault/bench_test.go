package vault

import (
	"context"
	"fmt"
	"io"
	"log"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gabrielassisxyz/houston/notes/internal/config"
	"github.com/gabrielassisxyz/houston/notes/internal/graph"
	"github.com/gabrielassisxyz/houston/notes/internal/graph/search"
)

// benchVaultNotes is the size of the synthetic vault: a work vault after a few
// years, and the size at which the two deferred speed-ups are decided.
const benchVaultNotes = 5000

// benchQueries is one Search operation: a word most notes carry, a word a
// tenth of them carry, a ticket identifier, and two words together.
var benchQueries = []string{"retrospective", "migration", "INC00000042", "deploy checklist"}

// writeBenchVault writes n synthetic notes under root, spread over fifty
// folders, without ids, as a vault the service has never seen: the first index
// injects an id into each. Every note has a title, tags, refs, a few wikilinks
// to other notes and about 1.5 KB of body.
func writeBenchVault(tb testing.TB, root string, n int) {
	tb.Helper()
	topics := []string{"migration", "incident", "planning", "review", "deploy", "budget", "hiring", "roadmap", "support", "design"}
	for i := 0; i < n; i++ {
		topic := topics[i%len(topics)]
		var b strings.Builder
		fmt.Fprintf(&b, "---\ntitle: Note %05d about %s\ntags: [area-%02d, %s]\nrefs: [STRY%08d, INC%08d]\n---\n\n", i, topic, i%50, topic, i, i%100)
		fmt.Fprintf(&b, "# Note %05d\n\n", i)
		for p := 0; p < 6; p++ {
			fmt.Fprintf(&b, "Paragraph %d of the %s notes: the team met for a retrospective, "+
				"walked the deploy checklist, and agreed on the next steps for org/repo-a. "+
				"Links to [[note-%05d]] and [[note-%05d]] keep the thread.\n\n", p, topic, (i+p+1)%n, (i*7+p)%n)
		}
		fmt.Fprintf(&b, "- [ ] follow up on CHG%08d\n- [x] notify https://example.com/status\n", i)
		path := filepath.Join(root, fmt.Sprintf("area-%02d", i%50), fmt.Sprintf("note-%05d.md", i))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			tb.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(b.String()), 0o644); err != nil {
			tb.Fatal(err)
		}
	}
}

// quietLogs discards slog output for the rest of the benchmark: the first
// index logs a line per note, and printing 5,000 of them would be measured
// with it.
func quietLogs(b *testing.B) {
	b.Helper()
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(io.Discard, nil)))
	b.Cleanup(func() {
		slog.SetDefault(previous)
		log.SetOutput(os.Stderr)
		log.SetFlags(log.LstdFlags)
	})
}

func benchConfig(root string) config.VaultConfig {
	cfg := config.VaultConfig{Root: root}
	ApplyDefaults(&cfg)
	return cfg
}

func openBenchGraph(b *testing.B, path string) *graph.Graph {
	b.Helper()
	g, err := graph.Open(context.Background(), graph.Config{Path: path})
	if err != nil {
		b.Fatalf("graph.Open: %v", err)
	}
	return g
}

// startTimed starts a service over g and root, timing Start alone: the first
// index, or a warm start's pass over an indexed vault, plus the watcher's
// setup. Stop and everything around it run outside the timer.
func startTimed(b *testing.B, g *graph.Graph, root string) {
	b.Helper()
	svc := New(g, benchConfig(root))
	b.StartTimer()
	err := svc.Start(context.Background())
	b.StopTimer()
	svc.Stop()
	if err != nil {
		b.Fatalf("Start: %v", err)
	}
}

// BenchmarkVault5000 measures the three numbers that decide the two deferred
// candidates: ColdStart is the first index of a vault the service has never
// seen (batching its writes is adopted above 10 s), WarmStart a restart over
// an indexed, unchanged vault (skipping unchanged files by modification time
// and size is adopted above 2 s), and Search one round of benchQueries over
// the indexed graph. Every fixture is built outside the timer, with a fresh
// database for each cold start. Run it inside notes/ with
//
//	go test -run='^$' -bench=BenchmarkVault5000 -benchtime=1x -count=3 ./internal/vault/...
func BenchmarkVault5000(b *testing.B) {
	quietLogs(b)

	b.Run("ColdStart", func(b *testing.B) {
		b.StopTimer()
		for i := 0; i < b.N; i++ {
			dir := b.TempDir()
			root := filepath.Join(dir, "vault")
			writeBenchVault(b, root, benchVaultNotes)
			g := openBenchGraph(b, filepath.Join(dir, "graph.db"))
			startTimed(b, g, root)
			_ = g.Close()
		}
	})

	// One indexed vault and database serve both remaining sub-benchmarks.
	dir := b.TempDir()
	root := filepath.Join(dir, "vault")
	dbPath := filepath.Join(dir, "graph.db")
	writeBenchVault(b, root, benchVaultNotes)
	g := openBenchGraph(b, dbPath)
	indexer := New(g, benchConfig(root))
	if err := indexer.Start(context.Background()); err != nil {
		b.Fatalf("indexing the shared fixture: %v", err)
	}
	indexer.Stop()
	_ = g.Close()

	b.Run("WarmStart", func(b *testing.B) {
		b.StopTimer()
		for i := 0; i < b.N; i++ {
			// A restart: a fresh handle on the same database and vault.
			g := openBenchGraph(b, dbPath)
			startTimed(b, g, root)
			_ = g.Close()
		}
	})

	b.Run("Search", func(b *testing.B) {
		b.StopTimer()
		g := openBenchGraph(b, dbPath)
		defer g.Close()
		ctx := context.Background()
		b.StartTimer()
		for i := 0; i < b.N; i++ {
			for _, q := range benchQueries {
				var hits []search.RankedHit
				if err := g.DoRead(ctx, func(tx *graph.ReadTx) error {
					var err error
					hits, err = search.RankedSearch(ctx, tx, q, "", "", "")
					return err
				}); err != nil {
					b.Fatalf("search %q: %v", q, err)
				}
				if len(hits) == 0 {
					b.Fatalf("search %q found nothing in the indexed vault", q)
				}
			}
		}
	})
}
