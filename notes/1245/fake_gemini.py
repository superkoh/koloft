import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

ANSWER = {
    "candidates": [
        {"content": {"role": "model", "parts": [{"text": "pong from the fake server"}]}, "finishReason": "STOP"}
    ],
    "usageMetadata": {"promptTokenCount": 3, "candidatesTokenCount": 4, "totalTokenCount": 7},
}


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("content-length") or 0)
        self.rfile.read(length)
        with open("/tmp/fake-calls.log", "a") as log:
            log.write(self.path + "\n")
        body = ("data: " + json.dumps(ANSWER) + "\n\n").encode()
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


HTTPServer(("127.0.0.1", int(sys.argv[1])), Handler).serve_forever()
