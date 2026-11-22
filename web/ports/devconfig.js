// @ts-check
// Dev sign-in menu port: asks the server which dev users exist, so the served page can offer them. Imports nothing.
// Contract test: test/web/adapters/devconfig.test.js (the http adapter, over a fake fetch).
//
// Contract:
//   get()  A Promise that ALWAYS resolves (never rejects) to either
//     { board, users: [{ name, token, role }] }   the server has dev tokens on: `board` is its dev board's id, each
//                                                  user a dev name, the token that user's hello carries, and its
//                                                  role (display only: the room decides the real role).
//     null                                         dev sign-in is off, or the server could not be asked, or it
//                                                  answered anything that is not this shape. A page treats all three
//                                                  alike: no dev sign-in.
//   Whether dev sign-in is allowed is the SERVER's answer only; the page never infers it from its own URL.
//
// Failure behaviour: every failure is null, so a production server (no such route: 404) costs one quiet request.

/**
 * @typedef {{ name: string, token: string, role: string }} DevUser
 * @typedef {{ board: string, users: DevUser[] }} DevMenu
 * @typedef {object} DevConfig
 * @property {() => Promise<DevMenu | null>} get
 */
export {};
