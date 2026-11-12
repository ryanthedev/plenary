// The SharedWorker entry, a composition root of its own (the worker's global scope): every tab of this browser on one
// board edits together through host.js, one local reference room per board.
import { roomHost } from "./host.js";
import { localRoom } from "../local.js";
import { DEV_USERS } from "../../../core/dev-users.js";

const host = roomHost({ makeNet: board => localRoom({ board, users: DEV_USERS, auto: true }) });
self.onconnect = e => host.connect(e.ports[0]);
