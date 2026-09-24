#!/usr/bin/env python3
"""The compat sweep's fixture server.

Serves `.github/scripts/ext-demo-pages/` as `python3 -m http.server` did, plus:
  - `/echo-headers`: a page that shows the request headers the server received, the
    `User-Agent` first (User-Agent Switcher's core check reads the header its rule put on the
    tab's request, as the desktop's round 7 read it), on `window.__headers` for a script;
    `/echo-headers?gzip=1` sends the same page gzip-encoded (`Content-Encoding: gzip`) when
    the request accepts it, so a document that reaches the tab through a relay of the phone's
    (a `webRequest.onHeadersReceived` listener with `responseHeaders`, a response-header rule)
    shows whether the relay hands the WebView a body it can decode (Stream Recorder's
    `ERR_CONTENT_DECODING_FAILED` on a live page, compat round 9);
  - the HLS types (`.m3u8`, `.ts`), so a recorder watching the tab's requests sees a playlist;
  - `Range` requests on the files it serves (`206 Partial Content` with `Content-Range`, and
    `Accept-Ranges: bytes` on every file), so a media element loads `clip.mp4` the way it loads a
    clip from a real origin – in pieces, a seek asking for the tail – and a request observer
    (Chrono Download Manager, Video Downloader PLUS: compat round 13) sees a media load's shape,
    and `/stream` is the same clip under an extension-less URL;
  - `/no-cors.json`: a JSON answer without `Access-Control-Allow-Origin`, for a page on the
    server's other origin (`cors.html`) whose fetch the browser refuses unless an extension
    sets the header on the response (Allow CORS);
  - `/cors/<file>`: a file of the directory answered WITH `Access-Control-Allow-Origin: *` and a
    `Content-Disposition`, ranges included, so a page on the server's other origin
    (`xo-media.html`) reads the response through `fetch` / `XMLHttpRequest` and records which
    response headers the browser lets it see; `?expose=1` adds `Access-Control-Expose-Headers`
    naming the non-safelisted ones (Content-Disposition, Content-Range, Accept-Ranges), and
    `/cors/large.mp4` is the clip zero-padded to 200,000 bytes under `video/mp4` (headers are
    what that load measures: a sniffer's size rule, compat round 14's item 1).

    python3 ext-fixture-server.py <port> <directory>
"""
import gzip
import html
import json
import os
import re
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit


class FixtureHandler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        '.m3u8': 'application/vnd.apple.mpegurl',
        '.ts': 'video/mp2t',
        '.js': 'text/javascript',
        '.mjs': 'text/javascript',
    }

    def do_GET(self):
        parts = urlsplit(self.path)
        if parts.path == '/echo-headers':
            self.echo_headers(parse_qs(parts.query).get('gzip', ['0'])[0] == '1')
            return
        if parts.path == '/no-cors.json':
            self.no_cors_json()
            return
        if parts.path.startswith('/cors/'):
            self.cors_file(parts.path[len('/cors/'):], parse_qs(parts.query).get('expose', ['0'])[0] == '1')
            return
        if parts.path == '/stream':
            # The clip under an extension-less URL (a CDN's `/videoplayback?...`): the same file,
            # `video/mp4` and ranges, for a request observer whose type comes from the URL's extension.
            self.path = '/clip.mp4' + ('?' + parts.query if parts.query else '')
        path = self.translate_path(self.path)
        if os.path.isfile(path):
            self.serves_file = True
            wanted = self.byte_range(os.path.getsize(path))
            if wanted is not None:
                self.send_range(path, wanted)
                return
        super().do_GET()

    def end_headers(self):
        if getattr(self, 'serves_file', False):
            self.send_header('Accept-Ranges', 'bytes')
        super().end_headers()

    def byte_range(self, size):
        """The `(first, last)` a `Range: bytes=` header asks for within `size`, or None (no header, or one this server does not serve)."""
        header = self.headers.get('Range')
        if not header:
            return None
        m = re.fullmatch(r'bytes=(\d*)-(\d*)', header.strip())
        if not m or (m.group(1) == '' and m.group(2) == ''):
            return None
        if m.group(1) == '':
            # A suffix range: the last N bytes.
            first = max(0, size - int(m.group(2)))
            last = size - 1
        else:
            first = int(m.group(1))
            last = int(m.group(2)) if m.group(2) else size - 1
        if first >= size:
            return (first, size - 1)
        return (first, min(last, size - 1))

    def send_range(self, path, wanted):
        size = os.path.getsize(path)
        first, last = wanted
        if first >= size:
            self.send_response(416)
            self.send_header('Content-Range', 'bytes */%d' % size)
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        length = last - first + 1
        self.send_response(206)
        self.send_header('Content-Type', self.guess_type(path))
        self.send_header('Content-Range', 'bytes %d-%d/%d' % (first, last, size))
        self.send_header('Content-Length', str(length))
        self.send_header('Last-Modified', self.date_time_string(int(os.stat(path).st_mtime)))
        self.end_headers()
        with open(path, 'rb') as f:
            f.seek(first)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(65536, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    LARGE_BYTES = 200000
    EXPOSED = 'Content-Disposition, Content-Range, Accept-Ranges, Last-Modified'

    def cors_file(self, name, expose):
        """`/cors/<name>` (see the module doc): the file with the CORS answer headers, a range honoured, `large.mp4` synthesised."""
        if '/' in name or name.startswith('.'):
            self.send_error(404)
            return
        if name == 'large.mp4':
            clip = self.translate_path('/clip.mp4')
            with open(clip, 'rb') as f:
                data = f.read()
            data = (data + b'\0' * self.LARGE_BYTES)[:self.LARGE_BYTES]
            content_type = 'video/mp4'
        else:
            path = self.translate_path('/' + name)
            if not os.path.isfile(path):
                self.send_error(404)
                return
            with open(path, 'rb') as f:
                data = f.read()
            content_type = self.guess_type(path)
        size = len(data)
        wanted = self.byte_range(size)
        if wanted is not None and wanted[0] >= size:
            self.send_response(416)
            self.send_header('Content-Range', 'bytes */%d' % size)
            self.send_header('Content-Length', '0')
            self.cors_headers(name, expose)
            self.end_headers()
            return
        if wanted is not None:
            first, last = wanted
            body = data[first:last + 1]
            self.send_response(206)
            self.send_header('Content-Range', 'bytes %d-%d/%d' % (first, last, size))
        else:
            body = data
            self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Last-Modified', self.date_time_string())
        self.cors_headers(name, expose)
        self.end_headers()
        self.wfile.write(body)

    def cors_headers(self, name, expose):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Disposition', 'inline; filename="%s"' % name)
        self.send_header('Cache-Control', 'no-store')
        if expose:
            self.send_header('Access-Control-Expose-Headers', self.EXPOSED)

    def no_cors_json(self):
        data = json.dumps({'fixture': 'no-cors', 'origin': self.headers.get('Origin'), 'host': self.headers.get('Host')}).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def echo_headers(self, gzipped):
        headers = {name: value for name, value in self.headers.items()}
        agent = headers.get('User-Agent', '')
        accepts_gzip = 'gzip' in headers.get('Accept-Encoding', '')
        encoded = gzipped and accepts_gzip
        body = (
            '<!doctype html><html lang="en"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width, initial-scale=1">'
            '<title>Header echo</title></head><body><h1>Header echo</h1>'
            '<p>The server received this request with:</p>'
            '<p>User-Agent: <code id="ua">%s</code></p>'
            '<p>Sent <code id="encoding">%s</code></p><pre id="headers">%s</pre>'
            '<script>window.__headers = %s; window.__encoding = %s</script></body></html>'
        ) % (
            html.escape(agent),
            'gzip' if encoded else 'identity',
            html.escape(json.dumps(headers, indent=1)),
            json.dumps(headers),
            json.dumps('gzip' if encoded else 'identity'),
        )
        data = body.encode('utf-8')
        if encoded:
            data = gzip.compress(data)
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        if encoded:
            self.send_header('Content-Encoding', 'gzip')
            self.send_header('Vary', 'Accept-Encoding')
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
