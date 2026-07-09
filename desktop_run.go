//go:build !android

package main

import (
	"log"

	"spindle/backend"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
)

// runDesktop opens the Wails window — everything desktop-specific lives
// here so the Android build (which only ever serves) excludes Wails.
func runDesktop(app *App) {
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
