package backend

import (
	"fmt"
	"os"
)

// Verbose download/API tracing is off by default so production runs don't
// spam stdout (some traces include request URLs). Set SPINDLE_DEBUG=1 to
// re-enable the full firehose when troubleshooting.
var debugEnabled = os.Getenv("SPINDLE_DEBUG") == "1"

func Dbgln(args ...any) {
	if debugEnabled {
		fmt.Println(args...)
	}
}

func Dbgf(format string, args ...any) {
	if debugEnabled {
		fmt.Printf(format, args...)
	}
}
