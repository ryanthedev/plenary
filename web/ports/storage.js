// Storage port: a small string key/value store (the session token, the per-browser library, UI preferences).
// Imports nothing. Contract test: test/web/contracts/storage-contract.js (storageContract).
//
// Contract:
//   get(key)         The string last set under key, or null when nothing is set. Synchronous.
//   set(key, value)  Store a string (value must be a string: anything else is a TypeError, never coerced).
//                    A later get(key) returns it exactly (empty string, unicode and long values included).
//   remove(key)      Forget key. Removing an absent key is fine.
//   Keys are independent: setting or removing one never changes another. Keys must be strings (TypeError).
//
// Failure behaviour: storage may be unavailable (private mode, blocked site data, a sandboxed frame) or full
// (quota). Then get, set and remove THROW an Error whose `code` is STORAGE_UNAVAILABLE (and `cause` the original
// error, if any). get never answers null for "could not read": null means "absent", and a silent null would make
// the caller act as if, say, no one were signed in when the store merely failed. Callers that can live without
// storage catch it and carry on in memory; match on err.code, never on the class.

/** err.code of every failure that means "the store could not do it" (unavailable or full). */
export const STORAGE_UNAVAILABLE = "storage-unavailable";

/**
 * @typedef {object} Storage
 * @property {(key: string) => string | null} get
 * @property {(key: string, value: string) => void} set
 * @property {(key: string) => void} remove
 */
