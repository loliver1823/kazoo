package main

import (
	"context"
	"embed"
	"encoding/json"
	"log"
	"os"

	"spindle/backend"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
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

	// Headless mode: `spindle serve [addr]` runs the full app behind an HTTP
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

	err := wails.Run(&options.App{
		Title:     "Spindle Music Manager",
		Width:     1024,
		Height:    600,
		MinWidth:  1024,
		MinHeight: 600,
		Frameless: true,
		AssetServer: &assetserver.Options{
			Assets: assets,
			// Fallback handler: streams library audio to the player
			// (/media/{id}) with Range support for seeking.
			Handler: backend.MediaHTTPHandler(),
		},
		BackgroundColour: &options.RGBA{R: 0, G: 0, B: 0, A: 255},
		OnStartup:        app.startup,
		OnShutdown:       app.shutdown,
		DragAndDrop: &options.DragAndDrop{
			EnableFileDrop:     true,
			DisableWebViewDrop: false,
			CSSDropProperty:    "--wails-drop-target",
			CSSDropValue:       "drop",
		},
		Bind: []interface{}{
			app,
		},
		Windows: &windows.Options{
			WebviewIsTransparent:              false,
			WindowIsTranslucent:               false,
			DisableWindowIcon:                 false,
			DisableFramelessWindowDecorations: false,
		},
	})

	if err != nil {
		log.Fatal("Error:", err.Error())
	}
}
