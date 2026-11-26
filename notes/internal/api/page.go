package api

import (
	"errors"
	"fmt"
	"net/url"
	"strconv"
)

// maxPageLimit bounds one page of a bulk listing.
const maxPageLimit = 500

// errBadPage refuses a limit or an offset outside its range.
var errBadPage = errors.New("invalid page")

// page is an opt-in window over a bulk listing. The bulk routes answered
// everything at once, which on a vault of thousands of notes is one answer of
// megabytes; a client that asks for a page gets one, and a client that does
// not gets the whole listing, as before.
type page struct {
	set    bool
	limit  int
	offset int
}

// parsePage reads limit and offset. Without either the listing is whole. With
// either, limit is an integer from 1 to maxPageLimit - maxPageLimit when only
// offset is given, since SQLite takes no OFFSET without a LIMIT - and offset a
// non-negative integer, 0 when only limit is given.
func parsePage(q url.Values) (page, error) {
	if !q.Has("limit") && !q.Has("offset") {
		return page{}, nil
	}
	p := page{set: true, limit: maxPageLimit}
	if q.Has("limit") {
		n, err := strconv.Atoi(q.Get("limit"))
		if err != nil || n < 1 || n > maxPageLimit {
			return page{}, fmt.Errorf("%w: limit must be an integer from 1 to %d, got %q", errBadPage, maxPageLimit, q.Get("limit"))
		}
		p.limit = n
	}
	if q.Has("offset") {
		n, err := strconv.Atoi(q.Get("offset"))
		if err != nil || n < 0 {
			return page{}, fmt.Errorf("%w: offset must be a non-negative integer, got %q", errBadPage, q.Get("offset"))
		}
		p.offset = n
	}
	return p, nil
}

// sqlClause returns the LIMIT and OFFSET to append to an ordered query, and
// their arguments; nothing for a whole listing.
func (p page) sqlClause() (string, []any) {
	if !p.set {
		return "", nil
	}
	return ` LIMIT ? OFFSET ?`, []any{p.limit, p.offset}
}

// pageOf applies p to a listing already in its fixed order.
func pageOf[T any](items []T, p page) []T {
	if !p.set {
		return items
	}
	start := min(p.offset, len(items))
	end := min(start+p.limit, len(items))
	return items[start:end]
}
