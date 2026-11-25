// Package vaultfile holds the byte-level helpers shared by every package that
// reads or writes a note in the vault: the frontmatter fence scanner and the
// atomic writer.
//
// It imports only the standard library and nothing of this module. Package
// vault imports the reconciler and the watcher, so a helper those packages
// need cannot live there without an import cycle.
package vaultfile

import "bytes"

// BlockState is what ScanFrontmatter found at the top of a file.
type BlockState int

const (
	// NoBlock means the file does not open with a fence line.
	NoBlock BlockState = iota
	// ClosedBlock means an opening fence and its closing fence were both found.
	ClosedBlock
	// UnclosedBlock means the file opens with a fence that no later line
	// closes. The callers disagree on what that is, on purpose: the parser
	// refuses it, while the body readers treat the whole file as body.
	UnclosedBlock
)

// Frontmatter locates the frontmatter block of a file. Every offset indexes the
// scanned bytes themselves, a BOM included, so they slice the input directly.
type Frontmatter struct {
	State BlockState
	// Open is where the opening fence line starts: 3 behind a BOM, else 0.
	Open int
	// Start is the first byte of the YAML, just past the opening fence's line
	// ending.
	Start int
	// Close is where the closing fence line starts, which is where the YAML
	// ends. Set only for ClosedBlock.
	Close int
	// End is just past the closing fence line and its line ending, or the
	// length of the input when that fence is the last line and has none. Set
	// only for ClosedBlock.
	End int
}

var utf8BOM = []byte{0xEF, 0xBB, 0xBF}

// ScanFrontmatter finds the frontmatter block at the top of raw.
//
// A fence line is "---" followed only by spaces or tabs before its line
// ending, LF or CRLF. The opening fence is the first line, after an optional
// UTF-8 BOM; the closing fence is the first later line that is a fence, and it
// alone may also end the file without a line ending. A line of four dashes is
// not a fence.
func ScanFrontmatter(raw []byte) Frontmatter {
	open := 0
	if bytes.HasPrefix(raw, utf8BOM) {
		open = len(utf8BOM)
	}
	start, ok := fenceLineEnd(raw, open, false)
	if !ok {
		return Frontmatter{State: NoBlock}
	}
	for pos := start; pos < len(raw); pos = nextLineStart(raw, pos) {
		if end, ok := fenceLineEnd(raw, pos, true); ok {
			return Frontmatter{State: ClosedBlock, Open: open, Start: start, Close: pos, End: end}
		}
	}
	return Frontmatter{State: UnclosedBlock, Open: open, Start: start}
}

// fenceLineEnd reports whether the line starting at pos is a fence, and
// returns the offset just past its line ending. Only a closing fence may end
// at the end of the input: an opening fence with no line after it opens
// nothing.
func fenceLineEnd(raw []byte, pos int, closing bool) (int, bool) {
	if !bytes.HasPrefix(raw[pos:], []byte("---")) {
		return 0, false
	}
	i := pos + 3
	for i < len(raw) && (raw[i] == ' ' || raw[i] == '\t') {
		i++
	}
	switch {
	case i == len(raw):
		return i, closing
	case raw[i] == '\n':
		return i + 1, true
	case raw[i] == '\r' && i+1 < len(raw) && raw[i+1] == '\n':
		return i + 2, true
	}
	return 0, false
}

// nextLineStart returns the offset just past the '\n' that ends the line
// holding pos, or the length of raw when that line is the last.
func nextLineStart(raw []byte, pos int) int {
	if i := bytes.IndexByte(raw[pos:], '\n'); i >= 0 {
		return pos + i + 1
	}
	return len(raw)
}
