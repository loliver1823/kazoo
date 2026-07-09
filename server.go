package main

// Headless server mode: exposes the full App API over HTTP + a WebSocket
// event stream, and serves the frontend with a shim that impersonates the
// Wails bridge. This is the portability layer — `spindle serve` runs the app
// in any browser, and the Android shell embeds the same server behind a
// WebView.

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"reflect"
	"strings"
	"sync"

	"spindle/backend"

	"github.com/gorilla/websocket"
)

type eventHub struct {
	mu    sync.Mutex
	conns map[*websocket.Conn]bool
}

var serveHub *eventHub

// serveBroadcast pushes an event to all connected frontends. Safe to call
// when the server isn't running (desktop Wails mode) — it's a no-op then.
func serveBroadcast(name string, data ...interface{}) {
	if serveHub == nil {
		return
	}
	payload, err := json.Marshal(map[string]interface{}{"name": name, "data": data})
	if err != nil {
		return
	}
	serveHub.mu.Lock()
	defer serveHub.mu.Unlock()
	for c := range serveHub.conns {
		if err := c.WriteMessage(websocket.TextMessage, payload); err != nil {
			c.Close()
			delete(serveHub.conns, c)
		}
	}
}

var wsUpgrader = websocket.Upgrader{
	// The server binds to loopback; the WebView/browser origin varies
	// (wails://, file://, http://localhost:port), so origin checks add
	// nothing here.
	CheckOrigin: func(r *http.Request) bool { return true },
}

// apiCall invokes an App method by name with a JSON array of arguments —
// the same call shape the Wails bridge uses.
func (a *App) apiCall(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(r.URL.Path, "/api/")
	method := reflect.ValueOf(a).MethodByName(name)
	if !method.IsValid() {
		http.Error(w, fmt.Sprintf("unknown method %q", name), http.StatusNotFound)
		return
	}

	var rawArgs []json.RawMessage
	if r.Body != nil {
		defer r.Body.Close()
		if err := json.NewDecoder(r.Body).Decode(&rawArgs); err != nil && err.Error() != "EOF" {
			http.Error(w, "bad arguments: "+err.Error(), http.StatusBadRequest)
			return
		}
	}

	mt := method.Type()
	if len(rawArgs) != mt.NumIn() {
		http.Error(w, fmt.Sprintf("%s expects %d args, got %d", name, mt.NumIn(), len(rawArgs)), http.StatusBadRequest)
		return
	}
	args := make([]reflect.Value, mt.NumIn())
	for i := 0; i < mt.NumIn(); i++ {
		v := reflect.New(mt.In(i))
		if err := json.Unmarshal(rawArgs[i], v.Interface()); err != nil {
			http.Error(w, fmt.Sprintf("arg %d of %s: %v", i, name, err), http.StatusBadRequest)
			return
		}
		args[i] = v.Elem()
	}

	results := method.Call(args)

	// Wails convention: a trailing error return becomes a rejected promise;
	// the (optional) first value is the payload. Error results must be
	// detected by TYPE — a nil error's Interface() is an untyped nil and
	// fails value assertions.
	errType := reflect.TypeOf((*error)(nil)).Elem()
	var payload interface{}
	for _, res := range results {
		if res.Type().Implements(errType) {
			if !res.IsNil() {
				http.Error(w, res.Interface().(error).Error(), http.StatusInternalServerError)
				return
			}
			continue
		}
		payload = res.Interface()
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(payload)
}

// StartServe blocks, serving the API, event stream, media streamer and the
// shimmed frontend on addr.
func (a *App) StartServe(addr string) error {
	serveHub = &eventHub{conns: map[*websocket.Conn]bool{}}

	dist, err := fs.Sub(assets, "frontend/dist")
	if err != nil {
		return err
	}
	indexHTML, err := fs.ReadFile(dist, "index.html")
	if err != nil {
		return err
	}
	// The shim must define window.go/window.runtime before the app bundle
	// (a deferred module) executes — a plain head script guarantees that.
	patched := strings.Replace(string(indexHTML), "<head>", `<head><script src="/wails-shim.js"></script>`, 1)

	mux := http.NewServeMux()
	mux.HandleFunc("/api/", a.apiCall)
	mux.HandleFunc("/events", func(w http.ResponseWriter, r *http.Request) {
		conn, err := wsUpgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		serveHub.mu.Lock()
		serveHub.conns[conn] = true
		serveHub.mu.Unlock()
		// Reader loop only to detect close.
		go func() {
			for {
				if _, _, err := conn.ReadMessage(); err != nil {
					serveHub.mu.Lock()
					delete(serveHub.conns, conn)
					serveHub.mu.Unlock()
					conn.Close()
					return
				}
			}
		}()
	})
	mux.HandleFunc("/wails-shim.js", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/javascript")
		w.Write([]byte(wailsShimJS))
	})
	media := backend.MediaHTTPHandler()
	mux.Handle("/media/", media)
	mux.Handle("/cover", media)
	mux.Handle("/artistart", media)
	fileServer := http.FileServer(http.FS(dist))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" || r.URL.Path == "/index.html" {
			w.Header().Set("Content-Type", "text/html")
			w.Write([]byte(patched))
			return
		}
		fileServer.ServeHTTP(w, r)
	})

	backend.Dbgf("serve mode listening on %s\n", addr)
	fmt.Println("Spindle serving on http://" + addr)
	return http.ListenAndServe(addr, mux)
}

const wailsShimJS = `(function () {
  var call = function (m, args) {
    return fetch('/api/' + m, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    }).then(function (r) {
      return r.text().then(function (t) {
        if (!r.ok) throw new Error(t || (m + ' failed: HTTP ' + r.status));
        return t ? JSON.parse(t) : null;
      });
    });
  };
  var appProxy = new Proxy({}, {
    get: function (_, m) {
      if (typeof m !== 'string') return undefined;
      return function () { return call(m, Array.prototype.slice.call(arguments)); };
    },
  });
  window.go = { main: { App: appProxy } };

  var listeners = {};
  window.runtime = {
    EventsOn: function (name, cb) {
      (listeners[name] = listeners[name] || []).push(cb);
      return function () {
        listeners[name] = (listeners[name] || []).filter(function (f) { return f !== cb; });
      };
    },
    EventsOnMultiple: function (name, cb, maxCallbacks) {
      var remaining = typeof maxCallbacks === 'number' ? maxCallbacks : -1;
      var off = window.runtime.EventsOn(name, function () {
        if (remaining === 0) { off(); return; }
        if (remaining > 0 && --remaining === 0) {
          var args = arguments; off(); cb.apply(null, args); return;
        }
        cb.apply(null, arguments);
      });
      return off;
    },
    EventsOnce: function (name, cb) {
      var off = window.runtime.EventsOn(name, function () { off(); cb.apply(null, arguments); });
      return off;
    },
    EventsOff: function (name) { delete listeners[name]; },
    EventsEmit: function () {},
    WindowMinimise: function () {},
    WindowToggleMaximise: function () {},
    WindowSetTitle: function () {},
    WindowFullscreen: function () {},
    WindowUnfullscreen: function () {},
    Quit: function () {},
    BrowserOpenURL: function (u) { window.open(u, '_blank'); },
    ClipboardSetText: function (t) { if (navigator.clipboard) navigator.clipboard.writeText(t); return Promise.resolve(true); },
    ClipboardGetText: function () { return navigator.clipboard ? navigator.clipboard.readText() : Promise.resolve(''); },
    Environment: function () { return Promise.resolve({ platform: 'server', arch: '', buildType: 'production' }); },
    LogPrint: function () {}, LogTrace: function () {}, LogDebug: function () {},
    LogInfo: function () {}, LogWarning: function () {}, LogError: function () {}, LogFatal: function () {},
  };

  function connect() {
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    var ws = new WebSocket(proto + location.host + '/events');
    ws.onmessage = function (e) {
      try {
        var msg = JSON.parse(e.data);
        (listeners[msg.name] || []).slice().forEach(function (cb) {
          cb.apply(null, msg.data || []);
        });
      } catch (err) { /* ignore malformed frames */ }
    };
    ws.onclose = function () { setTimeout(connect, 1500); };
  }
  connect();
})();
`
