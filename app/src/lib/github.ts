/**
 * GitHub helpers — deliberately OFF-CHAIN.
 *
 * The contract only ever accepts a 40-hex commit SHA, because a branch name is
 * mutable and would make validators fetch different bytes. Resolving
 * "owner/repo@main" into a frozen SHA is convenience work, so it belongs here,
 * in the browser, not on-chain.
 *
 * The similarity preview below is the same shingle-Jaccard the contract runs.
 * It is a courtesy so a hunter can see whether a claim is worth a bond — it is
 * never authoritative. Only the on-chain number, recomputed by every validator,
 * decides anything.
 */

export type RepoRef = { repo: string; sha: string };

const REPO_RE = /^[A-Za-z0-9._-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const SHA_RE = /^[0-9a-f]{40}$/;

/** Accepts "owner/repo", a github.com URL, or "owner/repo@ref". */
export function parseRepoInput(input: string): { repo: string; ref?: string } {
  let text = input.trim();

  const url = text.match(
    /github\.com\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)(?:\/(?:tree|blob|commit)\/([^/]+))?/,
  );
  if (url) return { repo: url[1].replace(/\.git$/, ""), ref: url[2] };

  const at = text.match(/^(.+?)@(.+)$/);
  if (at) return { repo: at[1].trim(), ref: at[2].trim() };

  return { repo: text.replace(/\.git$/, "") };
}

export async function resolveSha(repo: string, ref?: string): Promise<string> {
  if (!REPO_RE.test(repo)) throw new Error(`"${repo}" is not owner/repo`);
  if (ref && SHA_RE.test(ref)) return ref;

  const url = ref
    ? `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`
    : `https://api.github.com/repos/${repo}/commits?per_page=1`;

  const res = await fetch(url, { headers: { Accept: "application/vnd.github+json" } });
  if (res.status === 403)
    throw new Error("GitHub rate limit hit — paste a 40-char commit SHA instead");
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${repo}`);

  const data = await res.json();
  const sha = Array.isArray(data) ? data[0]?.sha : data?.sha;
  if (!sha || !SHA_RE.test(sha)) throw new Error(`could not resolve a SHA for ${repo}`);
  return sha;
}

export function rawUrl(repo: string, sha: string, path: string): string {
  return `https://raw.githubusercontent.com/${repo}/${sha}/${path}`;
}

export async function fetchRaw(
  repo: string,
  sha: string,
  path: string,
): Promise<string | null> {
  const res = await fetch(rawUrl(repo, sha, path));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`raw ${res.status} for ${path}`);
  return res.text();
}

/** Mirror of the contract's `_normalize` — comments and layout stripped. */
export function normalize(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/"""[\s\S]*?"""/g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/#[^\n]*/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

const SHINGLE = 5;

function shingles(text: string): Set<string> {
  const tokens = text.split(" ").filter(Boolean);
  if (tokens.length < SHINGLE) return new Set(tokens.length ? [tokens.join(" ")] : []);
  const out = new Set<string>();
  for (let i = 0; i <= tokens.length - SHINGLE; i++)
    out.add(tokens.slice(i, i + SHINGLE).join(" "));
  return out;
}

/** Same integer basis-points measure the contract computes. */
export function jaccardBp(left: string, right: string): number {
  const a = shingles(left);
  const b = shingles(right);
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const gram of a) if (b.has(gram)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : Math.floor((inter * 10000) / union);
}

export async function previewPair(
  origin: RepoRef,
  suspect: RepoRef,
  originPath: string,
  suspectPath: string,
): Promise<{ bp: number; identical: boolean }> {
  const [left, right] = await Promise.all([
    fetchRaw(origin.repo, origin.sha, originPath),
    fetchRaw(suspect.repo, suspect.sha, suspectPath),
  ]);
  if (left === null) throw new Error(`origin file not found: ${originPath}`);
  if (right === null) throw new Error(`suspect file not found: ${suspectPath}`);
  const a = normalize(left);
  const b = normalize(right);
  return { bp: jaccardBp(a, b), identical: a === b };
}
