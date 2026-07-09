//go:build android

package main

import (
	"context"
	"log"
)

// On Android there is no Wails window — the shell app execs this binary in
// serve mode and hosts the UI in a WebView. Reaching runDesktop means the
// caller forgot the `serve` argument; serve anyway on the default port.
func runDesktop(app *App) {
	app.serveMode = true
	app.startup(context.Background())
	if err := app.StartServe("127.0.0.1:8899"); err != nil {
		log.Fatal("Serve error:", err.Error())
	}
}
