# Serves Kongens Nytorv Home Games at http://localhost:8787 with caching off, so edits show on a normal reload.
import http.server, os

os.chdir(os.path.dirname(os.path.abspath(__file__)))

class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

print("Kongens Nytorv Home Games running at http://localhost:8787 (Ctrl+C to stop)")
http.server.ThreadingHTTPServer(("127.0.0.1", 8787), NoCache).serve_forever()
