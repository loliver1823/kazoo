package main

import (
	"context"
	"embed"
	"encoding/json"
	"log"
	"os"

	"kazoo/backend"
)

//go:embed all:frontend/dist
var assets embed.FS

//go:embed wails.json
var wailsJSON []byte

func main() {

	type wailsInfo struct {
		Info struct {
			ProductVersion string `json:"productVersion"`
		} `json:"info"`
	}
	var config wailsInfo
	if err := json.Unmarshal(wailsJSON, &config); err == nil && config.Info.ProductVersion != "" {
		backend.AppVersion = config.Info.ProductVersion
	}

	app := NewApp()

	// Headless mode: `kazoo serve [addr]` runs the full app behind an HTTP
	// bridge — the portability layer for browsers and the Android shell.
	if len(os.Args) > 1 && os.Args[1] == "serve" {
		addr := "127.0.0.1:8899"
		if len(os.Args) > 2 {
			addr = os.Args[2]
		}
		app.serveMode = true
		app.startup(context.Background())
		if err := app.StartServe(addr); err != nil {
			log.Fatal("Serve error:", err.Error())
		}
		return
	}

	runDesktop(app)
}
