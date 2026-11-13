/**
 * The secret scan: where a text looks like it holds a secret — the field, the line and the kind, never the secret itself.
 * A leaf module (agent-export.ts and the Library's schema both use it, and neither may import the other).
 */


const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ["private_key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["api_key", /\b(?:sk-[A-Za-z0-9_-]{16,}|[sr]k_(?:live|test)_[A-Za-z0-9]{16,}|hf_[A-Za-z0-9]{30,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|xapp-\d-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|npm_[A-Za-z0-9]{30,}|ya29\.[A-Za-z0-9._-]{20,})/],
  ["bot_token", /\b\d{7,12}:[A-Za-z0-9_-]{30,}\b/],
  // A Discord bot token has no label of its own: <base64 id>.<timestamp>.<hmac>. This fleet's own credential, so the shape most likely to be pasted.
  ["discord_token", /\b[MNO][A-Za-z0-9_-]{23,27}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/],
  ["webhook", /\b(?:discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/[A-Za-z0-9_-]{20,}|hooks\.slack\.com\/services\/T[A-Za-z0-9]+\/B[A-Za-z0-9]+\/[A-Za-z0-9]{16,})/i],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ["bearer", /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{20,}/],
  ["assignment", /\b[\w.-]{0,40}(?:api[_-]?key|secret|token|passwd|password|credential)[\w.-]{0,20}["']?\s*[:=]\s*["']?(?![<{$]|your|xxx|changeme|example)[A-Za-z0-9/+_.~=-]{16,}/i],
  ["url_password", /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]{3,}@/i],
];

export interface SecretFinding { field: string; line: number; kind: string }

/** Where a text looks like it holds a secret: the field, the line and the kind — never the secret itself. */
export function scanForSecrets(field: string, text: string): SecretFinding[] {
  const found: SecretFinding[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    // A very long line is read in overlapping pieces, so the patterns' cost stays small however long a line is.
    for (let at = 0; at === 0 || at < line.length; at += 3000) {
      const piece = line.slice(at, at + 4000);
      const hit = SECRET_PATTERNS.find(([, re]) => re.test(piece));
      if (hit) { found.push({ field, line: i + 1, kind: hit[0] }); break; }
    }
  });
  return found;
}
