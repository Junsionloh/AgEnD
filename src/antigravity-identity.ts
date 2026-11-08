/**
 * AGEND-113: which Google account this host's Antigravity sign-in is, for Settings → Accounts. Read from agy's own token file, locally: no process is started, no network request is
 * made, and what is returned is the masked identity of `parseAntigravityToken` (`ab***@example.com`) and nothing else. The file's text is passed to that parser and dropped here: it is
 * never kept, logged or sent, and neither is the path. A file that is missing, not a regular file, a link or too big gives nothing (an answer, not an error).
 *
 * Windows keeps this login in the Credential Manager, not in a file, so this is the host's (Linux, macOS, WSL) only; a paired Windows computer shows no account for it.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseAntigravityToken, type AccountIdentity } from "./claude-auth-status.js";

const MAX_BYTES = 64 * 1024;
/** Where agy keeps its token under the CLI's home: the same file the availability probe and the usage panel read. */
export const AGY_TOKEN_FILE = Object.freeze(["antigravity-cli", "antigravity-oauth-token"] as const);

export function readAntigravityIdentity(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): AccountIdentity | undefined {
  const file = join(env.GEMINI_HOME || join(home, ".gemini"), ...AGY_TOKEN_FILE);
  let fd: number | null = null;
  try {
    const before = lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_BYTES) return undefined;
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) return undefined;
    const buffer = Buffer.alloc(stat.size);
    let length = 0, count: number;
    while (length < buffer.length && (count = readSync(fd, buffer, length, buffer.length - length, null)) > 0) length += count;
    return parseAntigravityToken(buffer.subarray(0, length).toString("utf8"));
  } catch { return undefined; }
  finally { if (fd !== null) { try { closeSync(fd); } catch { /* read only */ } } }
}
