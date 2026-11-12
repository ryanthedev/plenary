// The transport contract run against the reference transport, so the contract itself is tested.
import { transportContract } from "./transport-contract.js";
import { referenceTransport } from "./reference-transport.js";

transportContract("reference", () => referenceTransport());
