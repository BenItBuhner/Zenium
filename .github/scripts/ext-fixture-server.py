#!/usr/bin/env python3
"""The compat sweep's fixture server.

Serves `.github/scripts/ext-demo-pages/` as `python3 -m http.server` did, plus:
  - `/echo-headers`: a page that shows the request headers the server received, the
    `User-Agent` first (User-Agent Switcher's core check reads the header its rule put on the
    tab's request, as the desktop's round 7 read it), on `window.__headers` for a script;
  - the HLS types (`.m3u8`, `.ts`), so a recorder watching the tab's requests sees a playlist.

    python3 ext-fixture-server.py <port> <directory>
"""
import html
import json
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class FixtureHandler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        '.m3u8': 'application/vnd.apple.mpegurl',
        '.ts': 'video/mp2t',
        '.js': 'text/javascript',
        '.mjs': 'text/javascript',
    }

    def do_GET(self):
        if self.path.split('?', 1)[0] == '/echo-headers':
            self.echo_headers()
            return
        super().do_GET()

    def echo_headers(self):
        headers = {name: value for name, value in self.headers.items()}
        agent = headers.get('User-Agent', '')
        body = (
            '<!doctype html><html lang="en"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width, initial-scale=1">'
            '<title>Header echo</title></head><body><h1>Header echo</h1>'
            '<p>The server received this request with:</p>'
            '<p>User-Agent: <code id="ua">%s</code></p><pre id="headers">%s</pre>'
            '<script>window.__headers = %s</script></body></html>'
        ) % (html.escape(agent), html.escape(json.dumps(headers, indent=1)), json.dumps(headers))
        data = body.encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    directory = sys.argv[2] if len(sys.argv) > 2 else '.'
    server = ThreadingHTTPServer(('0.0.0.0', port), partial(FixtureHandler, directory=directory))
    print('fixture server on port %d serving %s' % (port, directory), flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
