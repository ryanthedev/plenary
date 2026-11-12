// The shared Registry contract, run against the in-memory adapter. The engine runs the same function against its
// SQLite / Postgres adapters.
import { memoryRegistry } from "../../server/auth/registry.js";
import { registryContract } from "./registry-contract.js";

registryContract("memory", async ({ now }) => memoryRegistry({ now }), { batch: true });
