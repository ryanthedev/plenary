// The SharedWorker entry: every tab of this browser on one board edits together through room-host.js.
import { roomHost } from "./room-host.js";

const host = roomHost();
self.onconnect = e => host.connect(e.ports[0]);
