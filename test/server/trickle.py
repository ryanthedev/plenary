# A WebSocket client that reads far too slowly, for test/server/outbound.test.js. A Node or Bun socket can't do
# this (they pull from the kernel eagerly); here SO_RCVBUF is tiny and only a few KB are read each second, so the
# server's own buffer for this socket stays full while the reader still looks alive.
# usage: trickle.py <port> <path> <hello json> <bytes per read> <seconds between reads>
import base64, os, socket, struct, sys, time
port, path, hello, chunk, pause = int(sys.argv[1]), sys.argv[2], sys.argv[3].encode(), int(sys.argv[4]), float(sys.argv[5])
s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4096)
s.connect(("127.0.0.1", port))
key = base64.b64encode(os.urandom(16)).decode()
s.sendall(("GET %s HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n" % (path, key)).encode())
buf = b""
while b"\r\n\r\n" not in buf: buf += s.recv(1)
mask = os.urandom(4)
head = bytes([0x81, 0x80 | 126]) + struct.pack(">H", len(hello)) if len(hello) >= 126 else bytes([0x81, 0x80 | len(hello)])
s.sendall(head + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(hello)))
got = 0
try:
    while True:
        d = s.recv(chunk)
        if not d: break
        got += len(d)
        sys.stdout.write("%d\n" % got); sys.stdout.flush()
        time.sleep(pause)
except OSError:
    pass
