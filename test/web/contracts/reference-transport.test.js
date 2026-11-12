// The transport contract run against the reference transport, so the contract itself is tested.
import { transportContract } from "./transport-contract.js";
import { referenceTransport } from "./reference-transport.js";

transportContract("reference", () => referenceTransport());

// The bufferless branch of the backpressure section: the same transport with no outbound buffer to report.
transportContract("reference (bufferless)", () => {
  const d = referenceTransport();
  const { stall, drain, advance, ...rest } = d;
  return { ...rest, transport: { ...d.transport, congested: () => false }, bufferless: true };
});
