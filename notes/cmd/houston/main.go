// Command houston is the notes service of Houston's own notes engine.
//
// In this step it is minimal so the Go gate has a binary to build and check:
// help, --help and -h print the usage; any other verb exits 2 with an
// unknown-command message. A4 adds the first real verbs.
package main

import (
	"fmt"
	"os"
)

func usage() string {
	return "Usage: houston <command>\n\nCommands:\n  help          Print this usage\n"
}

func main() {
	if len(os.Args) < 2 {
		fmt.Print(usage())
		os.Exit(0)
	}
	verb := os.Args[1]
	switch verb {
	case "help", "--help", "-h":
		fmt.Print(usage())
		os.Exit(0)
	default:
		fmt.Fprintf(os.Stderr, "unknown command: %s\n", verb)
		os.Exit(2)
	}
}
