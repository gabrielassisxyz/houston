package reconcile

import "sort"

// ReportKind names why a file is out of the index, or indexed with something
// other than what it says.
type ReportKind string

const (
	// ReportDuplicateID: the file carries the id of a note another path
	// already holds, so it is left out and that path keeps the note.
	ReportDuplicateID ReportKind = "duplicate_id"
	// ReportUnknownPermission: the file declares a permission this service
	// does not know, and the note is indexed as "ask".
	ReportUnknownPermission ReportKind = "unknown_permission"
	// ReportInvalidUTF8: the file is not valid UTF-8, so it is neither indexed
	// nor written.
	ReportInvalidUTF8 ReportKind = "invalid_utf8"
	// ReportEmptyFile: the file has zero bytes, as a sync client's placeholder
	// does, so it is neither indexed nor written.
	ReportEmptyFile ReportKind = "empty_file"
)

// FileReport is one reason, for one file. Path is vault-relative.
type FileReport struct {
	Path   string     `json:"path"`
	Kind   ReportKind `json:"kind"`
	Detail string     `json:"detail"`
}

// Reports returns every report the reconciler holds, ordered by path and
// kind. They are kept by path, so a file that is fixed, deleted or no longer
// found by a cold start stops being counted.
func (r *Reconciler) Reports() []FileReport {
	r.reportsMu.Lock()
	defer r.reportsMu.Unlock()
	out := []FileReport{}
	for _, byKind := range r.reports {
		for _, rep := range byKind {
			out = append(out, rep)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Path != out[j].Path {
			return out[i].Path < out[j].Path
		}
		return out[i].Kind < out[j].Kind
	})
	return out
}

// report records kind for relPath, replacing an earlier report of that kind.
func (r *Reconciler) report(relPath string, kind ReportKind, detail string) {
	r.reportsMu.Lock()
	defer r.reportsMu.Unlock()
	if r.reports[relPath] == nil {
		r.reports[relPath] = map[ReportKind]FileReport{}
	}
	r.reports[relPath][kind] = FileReport{Path: relPath, Kind: kind, Detail: detail}
}

// clearReports forgets every report for relPath. Each pass over a file starts
// here and records again whatever still applies, so a report never outlives
// the condition it describes.
func (r *Reconciler) clearReports(relPath string) {
	r.reportsMu.Lock()
	defer r.reportsMu.Unlock()
	delete(r.reports, relPath)
}

// keepReportsOnly forgets the reports of every path not in found: a cold
// start's walk is the whole vault, so a path it did not reach is gone.
func (r *Reconciler) keepReportsOnly(found map[string]struct{}) {
	r.reportsMu.Lock()
	defer r.reportsMu.Unlock()
	for path := range r.reports {
		if _, ok := found[path]; !ok {
			delete(r.reports, path)
		}
	}
}
