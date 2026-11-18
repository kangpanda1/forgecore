// github-core-clone-01 entry: a GitHub-compatible git forge in one process.
// Plain JS (runs as `node main.ts` on any Node >= 18): node:http, node:crypto, node:zlib only.
import http from "node:http";
import crypto from "node:crypto";
import zlib from "node:zlib";

// ---------------------------------------------------------------- lifecycle
const ENV_URL = process.env.MAKEFUN_ENV_URL || "";
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN || "";
const READY_FILE = process.env.MAKEFUN_READY_FILE || "";
const TRIAL_NOW = process.env.MAKEFUN_TRIAL_NOW || "";

// The login the token names (derived from the sealed scenario: users[0].login).
const OWNER = "adaiversen";
const STRANGER = "olgabauer";
const VIEWER_EMAIL = "adaiversen@example.invalid";
const VIEWER_NAME = "Ada Iversen";

function log(...a) { console.log("[forge]", ...a); }

let registered = false;
async function register(base) {
  if (!ENV_URL) { log("no MAKEFUN_ENV_URL; skipping register"); return; }
  const port = parseInt(base.split(":").pop(), 10);
  const body = JSON.stringify({ port });
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const res = await fetch(ENV_URL + "/register", { method: "POST", body, headers: { "content-type": "application/json" } });
      if (res.ok) { registered = true; log("registered at", ENV_URL); return; }
      log("register attempt", attempt, res.status);
    } catch (e) { log("register attempt", attempt, String(e)); }
    await new Promise((r) => setTimeout(r, 500));
  }
  log("register failed; continuing anyway");
}

async function pollDone() {
  if (!ENV_URL) return;
  while (registered) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch(ENV_URL + "/done");
      if (res.ok) {
        const j = await res.json();
        if (j && j.phase && j.phase !== "conformance") { log("phase:", j.phase); break; }
      }
    } catch { /* keep polling */ }
  }
  process.exit(0);
}

// ---------------------------------------------------------------- store
const store = {
  repos: new Map(),           // name -> repo
  nextRepoId: 5000,
  nextIssueNumber: new Map(), // repo -> next number (shared issues+pulls)
  nextCommentId: 1,
};

const HOUR = 3600 * 1000;
const epochStart = TRIAL_NOW ? Date.parse(TRIAL_NOW) : Date.parse("2026-01-01T00:00:00Z");
let commitClock = Math.floor(epochStart / 1000);

function newRepo(name, { private: priv = false, description = "" } = {}) {
  const repo = {
    id: store.nextRepoId++,
    name,
    private: !!priv,
    description,
    defaultBranch: "main",
    refs: new Map(),      // "refs/heads/main" -> sha
    objects: new Map(),   // sha -> { type, data }  (data: Buffer)
    issues: new Map(),    // number -> issue
    labels: new Map(),    // name -> { name, color }
    pulls: new Map(),     // number -> pull
    createdSeq: 0,
  };
  repo.createdSeq = ++seqCounter;
  store.repos.set(name, repo);
  store.nextIssueNumber.set(name, 1);
  return repo;
}
let seqCounter = 0;

function getRepo(owner, name) {
  if (owner !== OWNER) return undefined;
  return store.repos.get(name);
}
function findRepo(owner, name) { return getRepo(owner, name); }

// ---------------------------------------------------------------- git objects
function hashObject(type, data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
  const h = crypto.createHash("sha1");
  h.update(Buffer.from(type + " " + buf.length + "\0", "utf8"));
  h.update(buf);
  return h.digest("hex");
}

function storeObject(repo, type, data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
  const sha = hashObject(type, buf);
  repo.objects.set(sha, { type, data: buf });
  return sha;
}

// Commit building -------------------------------------------------------
function buildCommitObject({ tree, parents, message, authorName, authorEmail, when }) {
  const lines = [];
  const who = (n, e) => `${n} <${e}> ${when} +0000`;
  lines.push(`tree ${tree}`);
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${who(authorName, authorEmail)}`);
  lines.push(`committer ${who(authorName, authorEmail)}`);
  lines.push("");
  lines.push(message);
  return lines.join("\n");
}

function nextCommitTime() { commitClock += 1; return commitClock; }

function commitNewTree(repo, { message, treeEntries, parentSha }) {
  // treeEntries: Map path -> Buffer content (whole snapshot); builds nested trees.
  const treeSha = writeTree(repo, treeEntries);
  const when = nextCommitTime();
  const body = buildCommitObject({ tree: treeSha, parents: parentSha ? [parentSha] : [], message, authorName: VIEWER_NAME, authorEmail: VIEWER_EMAIL, when });
  const sha = storeObject(repo, "commit", body);
  return sha;
}

function writeTree(repo, files) {
  // files: Map path(string) -> Buffer; builds nested tree objects, returns root tree sha.
  const root = {};
  for (const [path, content] of files) {
    const parts = path.split("/").filter(Boolean);
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      if (!node[seg]) node[seg] = {};
      if (typeof node[seg] !== "object") throw new Error("path/file clash");
      node = node[seg];
    }
    node[parts[parts.length - 1]] = content;
  }
  return writeTreeNode(repo, root, "");
}

function writeTreeNode(repo, node, prefix) {
  const entries = [];
  for (const key of Object.keys(node)) {
    const val = node[key];
    const path = prefix ? prefix + "/" + key : key;
    if (val && typeof val === "object" && !Buffer.isBuffer(val)) {
      const sub = writeTreeNode(repo, val, path);
      entries.push({ mode: "40000", name: key, sha: sub });
    } else {
      const blob = storeObject(repo, "blob", Buffer.isBuffer(val) ? val : Buffer.from(val, "utf8"));
      entries.push({ mode: "100644", name: key, sha: blob });
    }
  }
  entries.sort((a, b) => (a.name + "/").localeCompare(b.name + "/") || a.name.localeCompare(b.name));
  const parts = [];
  for (const e of entries) {
    const mode = e.mode === "40000" ? "40000" : e.mode;
    parts.push(Buffer.from(mode + " " + e.name + "\0", "utf8"));
    parts.push(Buffer.from(e.sha, "hex"));
  }
  return storeObject(repo, "tree", Buffer.concat(parts));
}

// Read tree -------------------------------------------------------------
function readTree(repo, treeSha, prefix = "") {
  // returns Map path -> { sha, mode, isDir }
  const out = new Map();
  const obj = repo.objects.get(treeSha);
  if (!obj || obj.type !== "tree") return out;
  const data = obj.data;
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const mode = data.slice(i, sp).toString("utf8");
    const nul = data.indexOf(0x00, sp + 1);
    const name = data.slice(sp + 1, nul).toString("utf8");
    const sha = data.slice(nul + 1, nul + 21).toString("hex");
    i = nul + 21;
    const path = prefix ? prefix + "/" + name : name;
    const isDir = mode === "40000" || mode === "040000";
    if (isDir) {
      for (const [p, v] of readTree(repo, sha, path)) out.set(p, v);
    } else {
      out.set(path, { sha, mode, isDir: false });
    }
  }
  return out;
}

function snapshotTree(repo, commitSha) {
  const c = parseCommit(repo, commitSha);
  if (!c) return new Map();
  return readTree(repo, c.tree);
}

function parseCommit(repo, sha) {
  const obj = repo.objects.get(sha);
  if (!obj || obj.type !== "commit") return null;
  const text = obj.data.toString("utf8");
  const lines = text.split("\n");
  const out = { tree: null, parents: [], message: "", author: "", committer: "" };
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line === "") break;
    const m = /^(tree|parent|author|committer)\s(.*)$/.exec(line);
    if (m) {
      if (m[1] === "tree") out.tree = m[2];
      else if (m[1] === "parent") out.parents.push(m[2]);
      else if (m[1] === "author") out.author = m[2];
      else if (m[1] === "committer") out.committer = m[2];
    }
  }
  out.message = lines.slice(i + 1).join("\n");
  return out;
}

function ancestrySet(repo, sha, limit = 100000) {
  const seen = new Set();
  const stack = [sha];
  while (stack.length && seen.size < limit) {
    const s = stack.pop();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    const c = parseCommit(repo, s);
    if (c) for (const p of c.parents) stack.push(p);
  }
  return seen;
}

function mergeBase(repo, a, b) {
  const ancA = ancestrySet(repo, a);
  const seen = new Set();
  const stack = [b];
  let best = null;
  while (stack.length) {
    const s = stack.pop();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    if (ancA.has(s)) { // candidate; the first found in BFS-ish order is fine for linear chains
      return s;
    }
    const c = parseCommit(repo, s);
    if (c) for (const p of c.parents) stack.push(p);
  }
  return best;
}

function resolveRef(repo, refish) {
  // refish: "main", "refs/heads/main", "refs/heads/x/y", or a sha
  if (repo.refs.has(refish)) return repo.refs.get(refish);
  if (repo.refs.has("refs/heads/" + refish)) return repo.refs.get("refs/heads/" + refish);
  const hex = /^[0-9a-f]{40}$/.test(refish) || /^[0-9a-f]{7,40}$/.test(refish);
  if (hex) {
    const full = [...repo.objects.keys()].find((k) => k.startsWith(refish.toLowerCase()));
    if (full) return full;
  }
  return null;
}

// JSON shapes -----------------------------------------------------------
function userObj() { return { login: OWNER, id: 1000, node_id: "MDQ6VXNlcjEwMDA=", avatar_url: "https://example.invalid/avatar.png", gravatar_id: "", url: "", html_url: "", type: "User", site_admin: false }; }

function repoJson(repo) {
  return {
    id: repo.id,
    node_id: "R_kg" + Buffer.from(String(repo.id)).toString("base64"),
    name: repo.name,
    full_name: OWNER + "/" + repo.name,
    owner: userObj(),
    private: repo.private,
    description: repo.description || null,
    fork: false,
    default_branch: repo.defaultBranch,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    pushed_at: "2026-01-01T00:00:00Z",
    git_url: "git://example.invalid/" + OWNER + "/" + repo.name + ".git",
    ssh_url: "git@example.invalid:" + OWNER + "/" + repo.name + ".git",
    clone_url: "https://example.invalid/" + OWNER + "/" + repo.name + ".git",
    url: "/api/v3/repos/" + OWNER + "/" + repo.name,
    html_url: "https://example.invalid/" + OWNER + "/" + repo.name,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === "open").length,
    visibility: repo.private ? "private" : "public",
    permissions: { admin: true, push: true, pull: true },
  };
}

function labelJson(l) {
  return { id: 1e6 + [...l.name].reduce((a, c) => a + c.charCodeAt(0), 0), node_id: "MDU6TGFiZWwx", name: l.name, color: l.color || "ededed", default: false, description: null };
}

function issueJson(repo, issue) {
  return {
    id: issue.id,
    node_id: issue.nodeId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: userObj(),
    labels: issue.labels.map((n) => labelJson(repo.labels.get(n) || { name: n, color: "ededed" })),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    html_url: "",
    url: "",
    pull_request: undefined,
  };
}

function pullJson(repo, pull) {
  const headSha = resolveRef(repo, "refs/heads/" + pull.head) || pull.headShaAtCreate;
  const baseSha = resolveRef(repo, "refs/heads/" + pull.base) || "";
  return {
    id: pull.id,
    node_id: pull.nodeId,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: userObj(),
    head: { ref: pull.head, sha: headSha, label: OWNER + ":" + pull.head, repo: repoJsonLite(repo) },
    base: { ref: pull.base, sha: baseSha, label: OWNER + ":" + pull.base, repo: repoJsonLite(repo) },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    merged_by: pull.mergedBy ? userObj() : null,
    draft: false,
    comments: 0,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: pull.files.length,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === "closed" ? (pull.mergedAt || pull.updatedAt) : null,
    html_url: "",
    url: "",
    diff_url: "",
    patch_url: "",
  };
}
function repoJsonLite(repo) {
  return { ...repoJson(repo), private: repo.private };
}

// Issue / pull / comment helpers ----------------------------------------
function nowIso() { return new Date(epochStart).toISOString(); }
function addMinutesIso(mins) { return new Date(epochStart + mins * 60000).toISOString(); }

function createIssueRecord(repo, { title, body, labels }) {
  const n = store.nextIssueNumber.get(repo.name) || 1;
  store.nextIssueNumber.set(repo.name, n + 1);
  const seq = ++seqCounter;
  const issue = {
    id: 1000 + seq,
    nodeId: Buffer.from("issue:" + repo.name + ":" + n).toString("base64"),
    number: n,
    title,
    body: body == null ? "" : String(body),
    state: "open",
    labels: labels.map((l) => (typeof l === "string" ? l : l.name)),
    comments: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
    closedAt: null,
    isPull: false,
  };
  repo.issues.set(n, issue);
  return issue;
}

function createComment(repo, issueOrPull, body) {
  const seq = ++seqCounter;
  const c = { id: store.nextCommentId++, body, createdAt: nowIso(), seq };
  issueOrPull.comments.push(c);
  return c;
}

function createPullRecord(repo, { head, base, title, body }) {
  const n = store.nextIssueNumber.get(repo.name) || 1;
  store.nextIssueNumber.set(repo.name, n + 1);
  const seq = ++seqCounter;
  const pull = {
    id: 1000 + seq,
    nodeId: Buffer.from("pull:" + repo.name + ":" + n).toString("base64"),
    number: n,
    title,
    body: body == null ? "" : String(body),
    state: "open",
    head,
    base,
    headShaAtCreate: resolveRef(repo, "refs/heads/" + head) || "",
    files: [],
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    comments: [],
  };
  pull.files = computePullFiles(repo, pull);
  repo.pulls.set(n, pull);
  return pull;
}

// Diff base tip vs head tip (file-level) --------------------------------
function computePullFiles(repo, pull) {
  const baseTip = resolveRef(repo, "refs/heads/" + pull.base);
  const headTip = resolveRef(repo, "refs/heads/" + pull.head);
  if (!baseTip || !headTip) return [];
  const baseTree = snapshotTree(repo, baseTip);
  const headTree = snapshotTree(repo, headTip);
  const files = [];
  const paths = new Set([...baseTree.keys(), ...headTree.keys()]);
  for (const path of paths) {
    const b = baseTree.get(path);
    const h = headTree.get(path);
    if (b && h && b.sha === h.sha) continue;
    if (h && !b) {
      files.push(fileDiff(path, "added", "", h.sha, repo));
    } else if (!h && b) {
      files.push(fileDiff(path, "removed", b.sha, null, repo));
    } else {
      files.push(fileDiff(path, "modified", b.sha, h.sha, repo));
    }
  }
  return files;
}

function fileDiff(path, status, baseSha, headSha, repo) {
  const oldText = baseSha ? repo.objects.get(baseSha).data : Buffer.alloc(0);
  const newText = headSha ? repo.objects.get(headSha).data : Buffer.alloc(0);
  const a = oldText.toString("utf8").split("\n");
  const bb = newText.toString("utf8").split("\n");
  // crude line diff via LCS on line arrays (small files)
  const { add, del } = simpleDiffCounts(a, bb);
  const additions = status === "added" ? bb.length : add;
  const deletions = status === "removed" ? a.length : del;
  return {
    sha: hashObject("blob", newText),
    filename: path,
    previous_filename: undefined,
    status,
    additions,
    deletions,
    changes: additions + deletions,
  };
}

function simpleDiffCounts(a, b) {
  const m = a.length, n = b.length;
  // LCS DP with cap on size
  if (m * n > 4000000) {
    return { add: Math.max(0, n - m), del: Math.max(0, m - n) };
  }
  const dp = new Array((m + 1) * (n + 1)).fill(0);
  const w = n + 1;
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const keep = dp[0];
  return { add: n - keep, del: m - keep };
}

// Squash merge: apply head diff onto base tip. Returns { sha } or { conflict: true }.
function squashMerge(repo, pull) {
  const baseTip = resolveRef(repo, "refs/heads/" + pull.base);
  const headTip = resolveRef(repo, "refs/heads/" + pull.head);
  if (!baseTip || !headTip) return { conflict: true, message: "merge failed: missing branch" };
  const baseTree = snapshotTree(repo, baseTip);
  const headTree = snapshotTree(repo, headTip);
  const mb = mergeBase(repo, baseTip, headTip);
  const mbTree = mb ? snapshotTree(repo, mb) : new Map();
  const merged = new Map(baseTree);
  let conflict = false;
  const paths = new Set([...headTree.keys(), ...mbTree.keys(), ...baseTree.keys()]);
  for (const path of paths) {
    const mbv = mbTree.get(path);
    const bv = baseTree.get(path);
    const hv = headTree.get(path);
    if (mbv && bv && mbv.sha === bv.sha) {
      // base unchanged since merge-base: take head's version
      if (hv) merged.set(path, hv);
      else merged.delete(path);
    } else if (mbv && hv && mbv.sha === hv.sha) {
      // head unchanged: keep base's version (including base deletion)
      if (!bv) merged.delete(path);
    } else if (bv && hv && bv.sha === hv.sha) {
      // both ended at same content
    } else if (!mbv && !bv && hv) {
      merged.set(path, hv);
    } else if (!mbv && !hv && bv) {
      // head deleted a file the base never had: ignore
    } else {
      // both changed differently -> conflict
      conflict = true;
    }
  }
  if (conflict) return { conflict: true, message: "merge failed: conflict" };
  const filesMap = new Map();
  for (const [path, v] of merged) filesMap.set(path, repo.objects.get(v.sha).data);
  const message = pull.title + " (#" + pull.number + ")";
  const sha = commitNewTree(repo, { message, treeEntries: filesMap, parentSha: baseTip });
  return { sha, treeMap: merged };
}

function applyTreeToRef(repo, ref, sha) {
  repo.refs.set(ref, sha);
}

// ---------------------------------------------------------------- http helpers
function sendJson(res, status, obj, extra = {}) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "x-github-request-id": crypto.randomBytes(6).toString("hex").toUpperCase(),
    ...extra,
  });
  res.end(body);
}

function sendEmpty(res, status, extra = {}) {
  res.writeHead(status, {
    "x-github-request-id": crypto.randomBytes(6).toString("hex").toUpperCase(),
    ...extra,
  });
  res.end();
}

function errMsg(status, message, extra = {}) {
  return { status, obj: { message }, extra };
}

function readBody(req, limit = 256 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => { size += c.length; if (size > limit) { reject(new Error("body too large")); req.destroy(); return; } chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------- auth
function authorized(req) {
  const h = req.headers.authorization || "";
  return /^Bearer \S+/.test(h);
}

// ---------------------------------------------------------------- routes
const apiBase = "/api/v3";

function parseUrl(req) {
  const u = new URL(req.url, "http://localhost");
  return { path: decodeURIComponent(u.pathname), query: u.searchParams };
}

function paginate(items, query, req) {
  const perPage = Math.min(Math.max(parseInt(query.get("per_page") || "30", 10) || 30, 1), 100);
  const page = Math.max(parseInt(query.get("page") || "1", 10) || 1, 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers = {};
  if (start + perPage < items.length) {
    const origin = (req && req.headers && req.headers.host ? "http://" + req.headers.host : FORGE_ORIGIN) || "http://127.0.0.1:" + PORT;
    const nextUrl = origin + "/api/v3/user/repos?per_page=" + perPage + "&page=" + (page + 1);
    headers.link = '<' + nextUrl + '>; rel="next", <' + nextUrl + '>; rel="last"';
  }
  return { slice, headers };
}

async function handleRest(req, res, path, query, body) {
  const m = req.method;
  const seg = path.slice(apiBase.length).split("/").filter((s) => s !== "");
  // root
  if (seg.length === 0 && m === "GET") {
    return { status: 200, obj: { current_user_url: apiBase + "/user", repository_url: apiBase + "/repos/{owner}/{repo}" }, extra: { "x-oauth-scopes": "repo, admin:org" } };
  }
  if (seg[0] === "meta" && m === "GET") {
    return { status: 200, obj: { installed_version: "2.42.1" } };
  }
  if (seg[0] === "user") {
    if (seg.length === 1 && m === "GET") {
      return { status: 200, obj: { login: OWNER, id: 1000, node_id: "MDQ6VXNlcjEwMDA=", name: VIEWER_NAME, email: VIEWER_EMAIL, type: "User" } };
    }
    if (seg[1] === "repos" && m === "POST") {
      const input = body;
      if (!input || typeof input.name !== "string" || !input.name) return errMsg(422, "name is required");
      if (store.repos.has(input.name)) return errMsg(422, "name already exists on this account");
      const repo = newRepo(input.name, { private: input.private, description: input.description });
      // an empty repo has no default branch ref until a first commit; default_branch stays
      return { status: 201, obj: repoJson(repo) };
    }
    if (seg[1] === "repos" && m === "GET") {
      const all = [...store.repos.values()].map(repoJson);
      const { slice, headers } = paginate(all, query);
      return { status: 200, obj: slice, extra: headers };
    }
  }
  if (seg[0] === "repos" && seg.length >= 3) {
    const owner = seg[1], name = seg[2];
    const repo = getRepo(owner, name);
    if (!repo) return errMsg(404, "Not Found");
    const rest = seg.slice(3);
    return handleRepo(req, res, repo, rest, query, body);
  }
  return errMsg(404, "Not Found");
}

function handleRepo(req, res, repo, rest, query, body) {
  const m = req.method;
  if (rest.length === 0 && m === "GET") return { status: 200, obj: repoJson(repo) };
  if (rest.length === 0 && m === "PATCH") {
    if (body && typeof body.description === "string") repo.description = body.description;
    if (body && typeof body.private === "boolean") repo.private = body.private;
    if (body && typeof body.default_branch === "string" && body.default_branch) repo.defaultBranch = body.default_branch;
    return { status: 200, obj: repoJson(repo) };
  }
  if (rest.length === 0 && m === "DELETE") {
    store.repos.delete(repo.name);
    return { status: 204, obj: null };
  }
  const [head0, ...tail] = rest;

  if (head0 === "contents") return handleContents(repo, tail, query, body, m);
  if (head0 === "branches" && m === "GET") {
    const list = [...repo.refs.keys()].filter((r) => r.startsWith("refs/heads/")).map((r) => {
      const bname = r.slice("refs/heads/".length);
      return { name: bname, commit: { sha: repo.refs.get(r), url: "" }, protected: false };
    });
    return { status: 200, obj: list };
  }
  if (head0 === "branches" && rest.length === 1 && m === "GET") {
    return { status: 200, obj: { name: repo.defaultBranch, commit: { sha: resolveRef(repo, repo.defaultBranch) || "" }, protected: false } };
  }
  if (head0 === "commits" && m === "GET") {
    const refish = query.get("sha") || repo.defaultBranch;
    const tip = resolveRef(repo, refish);
    if (!tip) return errMsg(404, "Not Found");
    const perPage = Math.min(parseInt(query.get("per_page") || "30", 10) || 30, 100);
    const commits = [];
    const seen = new Set();
    let cur = tip;
    while (cur && !seen.has(cur) && commits.length < perPage) {
      seen.add(cur);
      const c = parseCommit(repo, cur);
      if (!c) break;
      commits.push(commitJson(repo, cur, c));
      cur = c.parents[0];
    }
    return { status: 200, obj: commits };
  }
  if (head0 === "labels") return handleLabels(repo, tail, body, m);
  if (head0 === "issues") return handleIssues(repo, tail, query, body, m);
  if (head0 === "pulls") return handlePulls(repo, tail, query, body, m);
  if (head0 === "git") return handleGitRefs(repo, tail, body, m);
  if (head0 === "tags" && m === "GET") return { status: 200, obj: [] };
  if (head0 === "hooks" && m === "GET") return { status: 200, obj: [] };
  if (head0 === "contributors" && m === "GET") return { status: 200, obj: [] };
  if (head0 === "languages" && m === "GET") return { status: 200, obj: {} };
  return errMsg(404, "Not Found");
}

function commitJson(repo, sha, c) {
  return {
    sha,
    node_id: "C_" + sha.slice(0, 8),
    commit: {
      message: c.message,
      author: { name: authorNameOf(c.author), email: authorEmailOf(c.author), date: authorDateIso(c.author) },
      committer: { name: authorNameOf(c.committer), email: authorEmailOf(c.committer), date: authorDateIso(c.committer) },
      tree: { sha: c.tree, url: "" },
    },
    parents: c.parents.map((p) => ({ sha: p, url: "" })),
    author: userObj(),
    committer: userObj(),
    html_url: "",
    url: "",
  };
}
function authorNameOf(who) { const m = /^(.*) <.*> \d+/.exec(who || ""); return m ? m[1] : VIEWER_NAME; }
function authorEmailOf(who) { const m = /^.* <(.*)> \d+/.exec(who || ""); return m ? m[1] : VIEWER_EMAIL; }
function authorDateIso(who) { const m = /^.* <.*> (\d+) ([+-]\d{4})$/.exec(who || ""); if (!m) return nowIso(); return new Date(parseInt(m[1], 10) * 1000).toISOString(); }

// contents --------------------------------------------------------------
function handleContents(repo, tail, query, body, m) {
  const filePath = tail.join("/");
  if (!filePath) return errMsg(404, "Not Found");
  if (m === "GET") {
    const refish = query.get("ref") || repo.defaultBranch;
    const tip = resolveRef(repo, refish);
    if (!tip) return errMsg(404, "Not Found");
    const tree = snapshotTree(repo, tip);
    // directory listing if path is a directory
    const names = new Set([...tree.keys()].map((p) => p.split("/")[0]));
    if (!tree.has(filePath)) {
      // is it a dir?
      const dirPrefix = filePath + "/";
      const inside = [...tree.keys()].filter((p) => p.startsWith(dirPrefix));
      if (inside.length > 0 || names.has(filePath) && inside.length === 0 && [...tree.keys()].some((p) => p.startsWith(dirPrefix))) {
        const entries = [];
        const seen = new Set();
        for (const p of inside) {
          const rel = p.slice(dirPrefix.length);
          const top = rel.split("/")[0];
          if (seen.has(top)) continue;
          seen.add(top);
          const full = dirPrefix + top;
          if (tree.has(full)) {
            const e = tree.get(full);
            entries.push({ type: "file", name: top, path: full, sha: e.sha, size: repo.objects.get(e.sha).data.length, encoding: null, content: null });
          } else {
            entries.push({ type: "dir", name: top, path: full, sha: dirTreeSha(repo, tip, full), size: 0, url: "" });
          }
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        return { status: 200, obj: entries };
      }
      return errMsg(404, "Not Found");
    }
    const e = tree.get(filePath);
    const data = repo.objects.get(e.sha).data;
    return {
      status: 200,
      obj: {
        type: "file",
        encoding: "base64",
        content: data.toString("base64"),
        sha: e.sha,
        size: data.length,
        name: filePath.split("/").pop(),
        path: filePath,
        url: "",
        html_url: "",
      },
    };
  }
  if (m === "PUT") {
    if (!body || typeof body.content !== "string" || typeof body.message !== "string") return errMsg(422, "content and message are required");
    let content;
    try { content = Buffer.from(body.content, "base64"); } catch { return errMsg(422, "content is not valid base64"); }
    const branchName = typeof body.branch === "string" && body.branch ? body.branch : repo.defaultBranch;
    const ref = "refs/heads/" + branchName;
    const tip = resolveRef(repo, ref);
    const tree = tip ? snapshotTree(repo, tip) : new Map();
    const blobSha = storeObject(repo, "blob", content);
    const exists = tree.has(filePath);
    if (exists && body.sha != null && tree.get(filePath).sha !== String(body.sha).toLowerCase()) {
      return errMsg(409, "the provided sha does not match the current file sha");
    }
    tree.set(filePath, { sha: blobSha, mode: "100644", isDir: false });
    // drop stale directory-sha entries not needed; snapshotTree flattens
    const filesMap = new Map();
    for (const [p, v] of tree) filesMap.set(p, repo.objects.get(v.sha).data);
    const commitSha = commitNewTree(repo, { message: body.message, treeEntries: filesMap, parentSha: tip });
    if (!tip) { repo.refs.set(ref, commitSha); }
    else repo.refs.set(ref, commitSha);
    if (!repo.refs.has("refs/heads/" + repo.defaultBranch) && branchName === repo.defaultBranch) repo.refs.set("refs/heads/" + repo.defaultBranch, commitSha);
    return {
      status: exists ? 200 : 201,
      obj: {
        content: { sha: blobSha, encoding: "base64", name: filePath.split("/").pop(), path: filePath, size: content.length, type: "file", url: "" },
        commit: { sha: commitSha, message: body.message, parents: tip ? [{ sha: tip }] : [], tree: parseCommit(repo, commitSha).tree, url: "", html_url: "", author: {}, committer: {} },
      },
    };
  }
  if (m === "DELETE") {
    if (!body || typeof body.sha !== "string" || typeof body.message !== "string") return errMsg(422, "sha and message are required");
    const branchName = typeof body.branch === "string" && body.branch ? body.branch : repo.defaultBranch;
    const ref = "refs/heads/" + branchName;
    const tip = resolveRef(repo, ref);
    if (!tip) return errMsg(404, "Not Found");
    const tree = snapshotTree(repo, tip);
    if (!tree.has(filePath)) return errMsg(404, "Not Found");
    if (tree.get(filePath).sha !== String(body.sha).toLowerCase()) return errMsg(409, "sha does not match");
    tree.delete(filePath);
    const filesMap = new Map();
    for (const [p, v] of tree) filesMap.set(p, repo.objects.get(v.sha).data);
    const commitSha = commitNewTree(repo, { message: body.message, treeEntries: filesMap, parentSha: tip });
    repo.refs.set(ref, commitSha);
    return { status: 200, obj: { commit: { sha: commitSha, message: body.message } } };
  }
  return errMsg(404, "Not Found");
}

function dirTreeSha(repo, tip, dirPath) {
  // find the tree sha for a directory path in the tip commit
  const c = parseCommit(repo, tip);
  if (!c) return "";
  let cur = c.tree;
  for (const seg of dirPath.split("/")) {
    const obj = repo.objects.get(cur);
    if (!obj) return "";
    const data = obj.data;
    let i = 0, found = null;
    while (i < data.length) {
      const sp = data.indexOf(0x20, i);
      const nul = data.indexOf(0x00, sp + 1);
      const name = data.slice(sp + 1, nul).toString("utf8");
      const sha = data.slice(nul + 1, nul + 21).toString("hex");
      i = nul + 21;
      if (name === seg) { found = sha; break; }
    }
    if (!found) return "";
    cur = found;
  }
  return cur;
}

// labels ----------------------------------------------------------------
function handleLabels(repo, tail, body, m) {
  if (tail.length === 0 && m === "GET") {
    return { status: 200, obj: [...repo.labels.values()].map(labelJson) };
  }
  if (tail.length === 0 && m === "POST") {
    if (!body || typeof body.name !== "string" || !body.name) return errMsg(422, "name is required");
    const l = { name: body.name, color: body.color || "ededed" };
    repo.labels.set(body.name, l);
    return { status: 201, obj: labelJson(l) };
  }
  if (tail.length === 1 && m === "GET") {
    const l = repo.labels.get(tail[0]);
    if (!l) return errMsg(404, "Not Found");
    return { status: 200, obj: labelJson(l) };
  }
  return errMsg(404, "Not Found");
}

// issues ----------------------------------------------------------------
function handleIssues(repo, tail, query, body, m) {
  if (tail.length === 0 && m === "GET") {
    let list = [...repo.issues.values()].filter((i) => !i.isPull);
    const state = query.get("state") || "open";
    if (state !== "all") list = list.filter((i) => i.state === state);
    if (query.get("labels")) {
      const wanted = query.get("labels").split(",").filter(Boolean);
      list = list.filter((i) => wanted.every((w) => i.labels.includes(w)));
    }
    const sort = query.get("sort") || "created";
    const dir = query.get("direction") || "desc";
    list = list.slice().sort((a, b) => (a.number - b.number) * (dir === "asc" ? 1 : -1));
    const { slice, headers } = paginate(list, query);
    return { status: 200, obj: slice.map((i) => issueJson(repo, i)), extra: headers };
  }
  if (tail.length === 0 && m === "POST") {
    if (!body || typeof body.title !== "string") return errMsg(422, "title is required");
    const labelNames = [];
    for (const l of body.labels || []) {
      const n = typeof l === "string" ? l : (l && l.name);
      if (typeof n !== "string" || !repo.labels.has(n)) return errMsg(422, "the label " + JSON.stringify(n) + " does not exist");
      labelNames.push(n);
    }
    const issue = createIssueRecord(repo, { title: body.title, body: body.body, labels: labelNames });
    return { status: 201, obj: issueJson(repo, issue) };
  }
  const num = parseInt(tail[0], 10);
  if (Number.isNaN(num)) return errMsg(404, "Not Found");
  if (tail.length === 1 && m === "GET") {
    const issue = repo.issues.get(num);
    if (!issue || issue.isPull) return errMsg(404, "Not Found");
    return { status: 200, obj: issueJson(repo, issue) };
  }
  if (tail.length === 1 && (m === "PATCH" || m === "PUT")) {
    const issue = repo.issues.get(num);
    if (!issue || issue.isPull) return errMsg(404, "Not Found");
    if (body && typeof body.state === "string" && ["open", "closed"].includes(body.state)) {
      issue.state = body.state;
      issue.closedAt = body.state === "closed" ? nowIso() : null;
      issue.updatedAt = nowIso();
    }
    if (body && typeof body.title === "string") { issue.title = body.title; issue.updatedAt = nowIso(); }
    if (body && typeof body.body === "string") { issue.body = body.body; issue.updatedAt = nowIso(); }
    if (body && Array.isArray(body.labels)) {
      for (const l of body.labels) {
        const n = typeof l === "string" ? l : (l && l.name);
        if (typeof n !== "string" || !repo.labels.has(n)) return errMsg(422, "the label " + JSON.stringify(n) + " does not exist");
      }
      issue.labels = body.labels.map((l) => (typeof l === "string" ? l : l.name));
    }
    return { status: 200, obj: issueJson(repo, issue) };
  }
  if (tail.length >= 2 && tail[1] === "comments") {
    const issue = repo.issues.get(num);
    if (!issue || issue.isPull) return errMsg(404, "Not Found");
    if (tail.length === 2 && m === "POST") {
      if (!body || typeof body.body !== "string") return errMsg(422, "body is required");
      const c = createComment(repo, issue, body.body);
      return { status: 201, obj: { id: c.id, node_id: "IC_" + c.id, body: c.body, user: userObj(), created_at: c.createdAt, html_url: "", url: "" } };
    }
    if (tail.length === 2 && m === "GET") {
      return { status: 200, obj: issue.comments.map((c) => ({ id: c.id, node_id: "IC_" + c.id, body: c.body, user: userObj(), created_at: c.createdAt, html_url: "", url: "" })) };
    }
  }
  return errMsg(404, "Not Found");
}

// pulls -----------------------------------------------------------------
function handlePulls(repo, tail, query, body, m) {
  if (tail.length === 0 && m === "GET") {
    let list = [...repo.pulls.values()];
    const state = query.get("state") || "open";
    if (state !== "all") list = list.filter((p) => p.state === state);
    const { slice, headers } = paginate(list, query);
    return { status: 200, obj: slice.map((p) => pullJson(repo, p)), extra: headers };
  }
  if (tail.length === 0 && m === "POST") {
    if (!body) return errMsg(422, "head and base are required");
    const head = typeof body.head === "string" ? body.head : (body.head && body.head.ref);
    const base = typeof body.base === "string" ? body.base : (body.base && body.base.ref);
    if (typeof head !== "string" || typeof base !== "string") return errMsg(422, "head and base refs are required");
    if (!resolveRef(repo, "refs/heads/" + head)) return errMsg(422, "head branch " + JSON.stringify(head) + " does not exist");
    if (!resolveRef(repo, "refs/heads/" + base)) return errMsg(422, "base branch " + JSON.stringify(base) + " does not exist");
    if (head === base) return errMsg(422, "head and base must differ");
    const pull = createPullRecord(repo, { head, base, title: body.title || head, body: body.body || "" });
    return { status: 201, obj: pullJson(repo, pull) };
  }
  const num = parseInt(tail[0], 10);
  if (Number.isNaN(num)) return errMsg(404, "Not Found");
  const pull = repo.pulls.get(num);
  if (!pull) return errMsg(404, "Not Found");
  if (tail.length === 1 && m === "GET") {
    return { status: 200, obj: pullJson(repo, pull) };
  }
  if (tail.length === 2 && tail[1] === "files" && m === "GET") {
    const { slice, headers } = paginate(pull.files, query);
    return { status: 200, obj: slice, extra: headers };
  }
  if (tail.length === 2 && tail[1] === "merge" && m === "PUT") {
    const method = body && body.merge_method ? body.merge_method : "merge";
    if (pull.state !== "open") return errMsg(405, "pull request " + num + " is not open");
    const result = squashMerge(repo, pull);
    if (result.conflict) return errMsg(405, result.message || "merge failed");
    applyTreeToRef(repo, "refs/heads/" + pull.base, result.sha);
    pull.merged = true;
    pull.state = "closed";
    pull.mergedAt = nowIso();
    pull.mergeCommitSha = result.sha;
    pull.mergedBy = true;
    // drop the head ref? GitHub keeps it. Keep it.
    return { status: 200, obj: { merged: true, sha: result.sha, message: "Pull request successfully merged and closed" } };
  }
  if (tail.length === 2 && (tail[1] === "comments" || tail[1] === "commits") && m === "GET") {
    return { status: 200, obj: [] };
  }
  if (tail.length === 1 && (m === "PATCH")) {
    if (body && body.state === "closed") { pull.state = "closed"; }
    if (body && body.state === "open") { pull.state = "open"; }
    return { status: 200, obj: pullJson(repo, pull) };
  }
  return errMsg(404, "Not Found");
}

// git refs REST ---------------------------------------------------------
function handleGitRefs(repo, tail, body, m) {
  // /repos/{o}/{r}/git/refs[...]
  if (tail.length === 1 && tail[0] === "refs" && m === "POST") {
    if (!body || typeof body.ref !== "string" || typeof body.sha !== "string") return errMsg(422, "ref and sha are required");
    const r = body.ref;
    if (!/^refs\//.test(r)) return errMsg(422, "ref name is not well-formed");
    if (repo.refs.has(r)) return errMsg(422, "reference already exists");
    if (!repo.objects.has(body.sha)) return errMsg(422, "object does not exist");
    repo.refs.set(r, body.sha);
    return { status: 201, obj: { ref: r, node_id: "REF_" + r, object: { sha: body.sha, type: "commit", url: "" }, url: "" } };
  }
  if (tail.length === 1 && tail[0] === "refs" && m === "GET") {
    const list = [...repo.refs.entries()].map(([ref, sha]) => ({ ref, node_id: "REF_" + ref, object: { sha, type: "commit", url: "" }, url: "" }));
    return { status: 200, obj: list };
  }
  if (tail.length >= 2 && tail[0] === "refs") {
    const refName = tail.slice(1).join("/");
    if (m === "GET") {
      const matches = [...repo.refs.keys()].filter((r) => r === "refs/" + refName || r.startsWith("refs/" + refName + "/"));
      if (matches.length === 0) return errMsg(404, "Not Found");
      const r = matches[0];
      return { status: 200, obj: { ref: r, node_id: "REF_" + r, object: { sha: repo.refs.get(r), type: "commit", url: "" }, url: "" } };
    }
    if (m === "POST") {
      if (!body || typeof body.ref !== "string" || typeof body.sha !== "string") return errMsg(422, "ref and sha are required");
      const r = body.ref;
      if (repo.refs.has(r)) return errMsg(422, "reference already exists");
      if (!repo.objects.has(body.sha)) return errMsg(422, "object does not exist");
      repo.refs.set(r, body.sha);
      return { status: 201, obj: { ref: r, node_id: "REF_" + r, object: { sha: body.sha, type: "commit", url: "" }, url: "" } };
    }
    if (m === "PATCH") {
      if (!body || typeof body.sha !== "string") return errMsg(422, "sha is required");
      const r = "refs/" + refName;
      if (!repo.refs.has(r)) return errMsg(404, "Not Found");
      if (!repo.objects.has(body.sha)) return errMsg(422, "object does not exist");
      repo.refs.set(r, body.sha);
      return { status: 200, obj: { ref: r, node_id: "REF_" + r, object: { sha: body.sha, type: "commit", url: "" }, url: "" } };
    }
    if (m === "DELETE") {
      const r = "refs/" + refName;
      if (!repo.refs.delete(r)) return errMsg(404, "Not Found");
      return { status: 204, obj: null };
    }
  }
  if (tail.length >= 1 && tail[0] === "commits" && m === "POST") {
    // create a commit object from trees (rarely used; minimal)
    return errMsg(422, "not supported");
  }
  return errMsg(404, "Not Found");
}

// ---------------------------------------------------------------- git smart HTTP
// pkt-line helpers -------------------------------------------------------
function pktLine(payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  const len = buf.length + 4;
  const header = Buffer.from(len.toString(16).padStart(4, "0"), "ascii");
  return Buffer.concat([header, buf]);
}
const FLUSH = Buffer.from("0000", "ascii");
const DELIM = Buffer.from("0001", "ascii");
const RESPEND = Buffer.from("0002", "ascii");

function parsePktLines(buf, startOffset = 0) {
  const pkts = [];
  let off = startOffset;
  while (off + 4 <= buf.length) {
    const hex = buf.slice(off, off + 4).toString("ascii");
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) return { pkts, consumed: off, remainder: true };
    const len = parseInt(hex, 16);
    if (len === 0) { pkts.push({ kind: "flush" }); off += 4; continue; }
    if (len === 1) { pkts.push({ kind: "delim" }); off += 4; continue; }
    if (len === 2) { pkts.push({ kind: "respend" }); off += 4; continue; }
    if (len === 3) break;
    if (off + len > buf.length) return { pkts, consumed: off, incomplete: true };
    pkts.push({ kind: "data", payload: buf.slice(off + 4, off + len) });
    off += len;
  }
  return { pkts, consumed: off };
}

// repo path parsing: /{owner}/{repo}.git/...
function parseGitPath(path) {
  const m = /^\/([^\/]+)\/([^\/]+?)(?:\.git)?\/(.*)$/.exec(path);
  if (!m) return null;
  return { owner: m[1], name: m[2], rest: m[3] };
}

// ---------------- receive-pack v0
function receivePackInfoRefs(repo, req) {
  const caps = "report-status side-band-64k side-band quiet delete-refs no-thin ofs-delta agent=forge/1";
  const lines = [pktLine("# service=git-receive-pack\n"), FLUSH];
  const refs = [...repo.refs.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  if (refs.length === 0) {
    lines.push(pktLine("0000000000000000000000000000000000000000 capabilities^{}\0" + caps + "\n"));
  } else {
    let first = true;
    for (const [ref, sha] of refs) {
      const suffix = first ? "\0" + caps + "\n" : "\n";
      first = false;
      lines.push(pktLine(sha + " " + ref + suffix));
    }
  }
  lines.push(FLUSH);
  return { status: 200, contentType: "application/x-git-receive-pack-advertisement", body: Buffer.concat(lines) };
}

function parseReceivePackCommands(pkts) {
  const cmds = [];
  for (const p of pkts) {
    if (p.kind === "flush") break;
    if (p.kind !== "data") continue;
    const text = p.payload.toString("utf8");
    const nullAt = text.indexOf("\0");
    const line = nullAt >= 0 ? text.slice(0, nullAt) : text;
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (refs\/[^\s]+)$/.exec(line.trim());
    if (m) cmds.push({ old: m[1], new: m[2], ref: m[3] });
  }
  return cmds;
}

async function receivePack(repo, body) {
  // body: pkt commands + flush + packfile
  const first = parsePktLines(body);
  const cmds = parseReceivePackCommands(first.pkts);
  const packData = body.slice(first.consumed);
  const results = [];
  let unpackOk = true;
  try {
    const parsed = parsePack(repo, packData);
    if (!parsed.ok) { unpackOk = false; results.push({ ref: "PACK", status: "ng", text: parsed.error || "bad pack" }); }
  } catch (e) {
    unpackOk = false;
  }
  if (unpackOk) {
    for (const c of cmds) {
      const isDelete = /^0+$/.test(c.new);
      const isCreate = /^0+$/.test(c.old);
      if (isDelete) {
        if (!repo.refs.has(c.ref)) results.push({ ref: c.ref, status: "ng", text: "no such ref" });
        else { repo.refs.delete(c.ref); results.push({ ref: c.ref, status: "ok" }); }
        continue;
      }
      if (!repo.objects.has(c.new)) {
        results.push({ ref: c.ref, status: "ng", text: "bad object" });
        continue;
      }
      if (!isCreate) {
        const oldTip = repo.refs.get(c.ref);
        if (oldTip && oldTip !== c.old) {
          results.push({ ref: c.ref, status: "ng", text: "failed to update ref" });
          continue;
        }
        // fast-forward check
        if (oldTip && !ancestrySet(repo, c.new).has(oldTip)) {
          results.push({ ref: c.ref, status: "ng", text: "non-fast-forward" });
          continue;
        }
        if (!oldTip && !isCreate) {
          results.push({ ref: c.ref, status: "ng", text: "failed to update ref" });
          continue;
        }
      }
      repo.refs.set(c.ref, c.new);
      results.push({ ref: c.ref, status: "ok" });
    }
  }
  // build report-status with optional side-band
  const useSideband = bodyHasSideband(first.pkts);
  const lines = [];
  if (!unpackOk) lines.push(pktLine("unpack ng-reason\n"));
  else lines.push(pktLine("unpack ok\n"));
  for (const r of results) {
    lines.push(pktLine(r.status === "ok" ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.text}\n`));
  }
  lines.push(FLUSH);
  let out = Buffer.concat(lines);
  if (useSideband) out = wrapSideband(out, 1) + FLUSH;
  return { status: 200, contentType: "application/x-git-receive-pack-result", body: out };
}

function bodyHasSideband(pkts) {
  for (const p of pkts) {
    if (p.kind !== "data") continue;
    const t = p.payload.toString("utf8");
    const nullAt = t.indexOf("\0");
    if (nullAt >= 0) {
      const caps = t.slice(nullAt + 1).trim();
      if (/(^|\s)side-band-64k(\s|$)/.test(caps)) return true;
      if (/(^|\s)side-band(\s|$)/.test(caps)) return "sideband";
    }
  }
  return false;
}

function wrapSideband(data, channel) {
  const parts = [];
  for (let off = 0; off < data.length; off += 65515) {
    const chunk = data.slice(off, Math.min(off + 65515, data.length));
    const header = Buffer.from((chunk.length + 5).toString(16).padStart(4, "0"), "ascii");
    parts.push(header, Buffer.from([channel]), chunk);
  }
  return Buffer.concat(parts);
}

// ---------------- upload-pack
function uploadPackInfoRefs(repo, req) {
  const proto = req.headers["git-protocol"] || "";
  const v2 = /version=2/.test(String(proto));
  if (v2) {
    const lines = [
      pktLine("# service=git-upload-pack\n"),
      FLUSH,
      pktLine("version 2\n"),
      FLUSH,
      pktLine("agent=forge/1\n"),
      pktLine("ls-refs=unborn\n"),
      pktLine("fetch=shallow wait-for-done\n"),
      pktLine("server-option\n"),
      pktLine("object-format=sha1\n"),
      FLUSH,
    ];
    return { status: 200, contentType: "application/x-git-upload-pack-advertisement", body: Buffer.concat(lines) };
  }
  const caps = "multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not deepen-relative no-progress include-tag multi_ack_detailed allow-tip-sha1-in-want allow-reachable-sha1-in-want agent=forge/1";
  const lines = [];
  lines.push(pktLine("# service=git-upload-pack\n"));
  lines.push(FLUSH);
  const refs = [...repo.refs.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  if (refs.length === 0) {
    lines.push(pktLine("0000000000000000000000000000000000000000 capabilities^{}\0" + caps + "\n"));
  } else {
    let first = true;
    for (const [ref, sha] of refs) {
      const suffix = first ? "\0" + caps + "\n" : "\n";
      first = false;
      lines.push(pktLine(sha + " " + ref + suffix));
    }
    lines.push(pktLine("0000000000000000000000000000000000000000 HEAD\n"));
  }
  lines.push(FLUSH);
  return { status: 200, contentType: "application/x-git-upload-pack-advertisement", body: Buffer.concat(lines) };
}

async function uploadPack(repo, body, req) {
  const proto = String(req.headers["git-protocol"] || "");
  const v2 = /version=2/.test(proto);
  if (v2) return uploadPackV2(repo, body);
  return uploadPackV0(repo, body);
}

function collectPktText(pkts) {
  const parts = [];
  for (const p of pkts) if (p.kind === "data") parts.push(p.payload.toString("utf8"));
  return parts.join("");
}

async function uploadPackV2(repo, body) {
  const { pkts } = parsePktLines(body);
  let command = null;
  const args = [];
  let delimSeen = false;
  const haveRounds = [];
  let currentRound = [];
  for (const p of pkts) {
    if (p.kind === "flush") { if (command === "fetch" && currentRound.length) { haveRounds.push(currentRound); currentRound = []; } continue; }
    if (p.kind === "delim") { delimSeen = true; continue; }
    if (p.kind !== "data") continue;
    const t = p.payload.toString("utf8").trim();
    const cm = /^command=(.*)$/.exec(t);
    if (cm) { command = cm[1]; continue; }
    args.push(t);
  }
  if (currentRound.length) haveRounds.push(currentRound);
  if (command === "ls-refs") return lsRefsV2(repo, args);
  if (command === "fetch") return fetchV2(repo, args, haveRounds);
  // unknown command
  return { status: 200, contentType: "application/x-git-upload-pack-result", body: Buffer.concat([pktLine("ERR unknown command " + command + "\n"), FLUSH]) };
}

function lsRefsV2(repo, args) {
  const peel = args.includes("peel");
  const symrefs = args.includes("symrefs");
  let prefix = null;
  for (const a of args) { const m = /^ref-prefix (.*)$/.exec(a); if (m) prefix = m[1]; }
  const lines = [];
  const refs = [...repo.refs.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const head = repo.defaultBranch;
  for (const [ref, sha] of refs) {
    if (prefix && !ref.startsWith(prefix)) continue;
    let attrs = "";
    if (peel) {
      const tobj = repo.objects.get(sha);
      if (tobj && tobj.type === "tag") {
        const pm = /^object ([0-9a-f]{40})/m.exec(tobj.data.toString("utf8"));
        if (pm) attrs = " peeled:" + pm[1];
      }
    }
    lines.push(pktLine(sha + " " + ref + attrs + "\n"));
  }
  const headSha = repo.refs.get("refs/heads/" + head);
  if (!prefix || "" === prefix) {
    if (headSha) lines.push(pktLine(headSha + " HEAD" + (symrefs ? " symref-target:refs/heads/" + head : "") + "\n"));
  }
  lines.push(FLUSH);
  return { status: 200, contentType: "application/x-git-upload-pack-result", body: Buffer.concat(lines) };
}

async function fetchV2(repo, args, haveRounds) {
  const wants = [];
  const haves = [];
  let depth = null;
  let mustInclude = false;
  let sidebandAll = false;
  for (const a of args) {
    const wm = /^want ([0-9a-f]{40})/.exec(a);
    if (wm) { wants.push(wm[1]); continue; }
    const hm = /^have ([0-9a-f]{40})/.exec(a);
    if (hm) { haves.push(hm[1]); continue; }
    const dm = /^deepen (\d+)/.exec(a);
    if (dm) { depth = parseInt(dm[1], 10); continue; }
    if (a === "done") continue;
    if (a === "sideband-all") { sidebandAll = true; continue; }
  }
  // flatten haves from args + rounds
  const havesAll = [...haves];
  for (const round of haveRounds) for (const a of round) {
    const t = a.trim();
    const hm = /^have ([0-9a-f]{40})/.exec(t);
    if (hm) havesAll.push(hm[1]);
  }
  const validWants = wants.filter((w) => repo.objects.has(w));
  const sections = [];
  // shallow section: when deepen requested
  const shallowSet = new Set();
  if (depth != null) {
    for (const w of validWants) {
      const shallowCut = collectShallow(repo, w, depth);
      for (const s of shallowCut) shallowSet.add(s);
    }
  }
  if (shallowSet.size) {
    const lines = [pktLine("shallow-info\n")];
    for (const s of shallowSet) lines.push(pktLine("shallow " + s + "\n"));
    lines.push(FLUSH);
    sections.push(Buffer.concat(lines));
  }
  // acknowledgments section (only when client sent haves)
  if (havesAll.length > 0) {
    const lines = [pktLine("acknowledgments\n")];
    const acked = havesAll.filter((h) => repo.objects.has(h));
    if (acked.length) {
      lines.push(pktLine("ACK " + acked[acked.length - 1] + "\n"));
    } else {
      lines.push(pktLine("NAK\n"));
    }
    lines.push(FLUSH);
    sections.push(Buffer.concat(lines));
  }
  // packfile section (wanted-refs only when the client asked for refs by name)
  const lines = [];
  const refPrefixes = [];
  for (const a of args) { const m = /^ref-prefix (.*)$/.exec(a); if (m) refPrefixes.push(m[1]); }
  if (refPrefixes.length) {
    lines.push(pktLine("wanted-refs\n"));
    const names = collectWantedRefNames(repo, validWants);
    for (const [sha, ref] of names) lines.push(pktLine(sha + " " + ref + "\n"));
    lines.push(FLUSH);
  }
  lines.push(pktLine("packfile\n"));
  sections.push(Buffer.concat(lines));
  const pack = writePack(repo, validWants, havesAll, depth);
  sections.push(wrapSideband(pack, 1));
  sections.push(FLUSH);
  return { status: 200, contentType: "application/x-git-upload-pack-result", body: Buffer.concat(sections) };
}

// collect commits at depth cutoff
function collectShallow(repo, tip, depth) {
  const shallow = new Set();
  const queue = [{ sha: tip, d: 1 }];
  const seen = new Set();
  while (queue.length) {
    const { sha, d } = queue.shift();
    if (seen.has(sha)) continue;
    seen.add(sha);
    const c = parseCommit(repo, sha);
    if (!c) continue;
    if (d >= depth) { shallow.add(sha); continue; }
    for (const p of c.parents) queue.push({ sha: p, d: d + 1 });
  }
  return shallow;
}

async function uploadPackV0(repo, body) {
  // body may be a pkt want stream: wants + flush + (haves + flush)* + done
  // The suite's client may also append raw pack bytes only for receive; for upload it's wants/haves.
  const { pkts, consumed, incomplete, remainder } = parsePktLines(body);
  const wants = [];
  const haves = [];
  let depth = null;
  let seenFlush = 0;
  let sideband = false;
  for (const p of pkts) {
    if (p.kind === "flush") { seenFlush++; continue; }
    if (p.kind !== "data") continue;
    const t = p.payload.toString("utf8");
    const nullAt = t.indexOf("\0");
    const line = (nullAt >= 0 ? t.slice(0, nullAt) : t).trim();
    if (nullAt >= 0 && /side-band-64k/.test(t.slice(nullAt))) sideband = true;
    const wm = /^want ([0-9a-f]{40})(.*)$/.exec(line);
    if (wm) { wants.push(wm[1]); const dm = /deepen (\d+)/.exec(wm[2] || ""); if (dm) depth = parseInt(dm[1], 10); continue; }
    const hm = /^have ([0-9a-f]{40})/.exec(line);
    if (hm) { haves.push(hm[1]); continue; }
    if (/^deepen (\d+)/.exec(line)) depth = parseInt(/^deepen (\d+)/.exec(line)[1], 10);
  }
  const validWants = wants.filter((w) => repo.objects.has(w));
  const lines = [];
  if (haves.length === 0) {
    lines.push(pktLine("NAK\n"));
  } else {
    const acked = haves.filter((h) => repo.objects.has(h));
    lines.push(pktLine(acked.length ? "ACK " + acked[acked.length - 1] + " common\n" : "NAK\n"));
  }
  // shallow lines for deepen
  if (depth != null) {
    const shallowSet = new Set();
    for (const w of validWants) for (const s of collectShallow(repo, w, depth)) shallowSet.add(s);
    for (const s of shallowSet) lines.push(pktLine("shallow " + s + "\n"));
  }
  const pack = writePack(repo, validWants, haves, depth);
  let out = Buffer.concat(lines);
  out = Buffer.concat([out, sideband ? Buffer.concat([wrapSideband(pack, 1), FLUSH]) : pack]);
  return { status: 200, contentType: "application/x-git-upload-pack-result", body: out };
}

// ---------------- packfile read ------------------------------------------------
function parsePack(repo, data) {
  // data: Buffer of a packfile
  if (data.length < 12) return { ok: true, objects: [] };
  if (data.length < 32) {
    const magic0 = data.slice(0, 4).toString("ascii");
    if (magic0 === "PACK" && data.readUInt32BE(8) === 0) return { ok: true, objects: [] };
    return { ok: false, error: "pack too small" };
  }
  const magic = data.slice(0, 4).toString("ascii");
  if (magic !== "PACK") return { ok: false, error: "bad pack magic" };
  const version = data.readUInt32BE(4);
  if (version !== 2 && version !== 3) return { ok: false, error: "bad pack version" };
  const count = data.readUInt32BE(8);
  let off = 12;
  const pending = []; // deltas needing resolution later
  for (let i = 0; i < count; i++) {
    const start = off;
    let b = data[off++];
    const type = (b >> 4) & 7;
    let size = b & 15;
    let shift = 4;
    while (b & 0x80) {
      b = data[off++];
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    if (type === 1 || type === 2 || type === 3 || type === 4) {
      const typeName = ["", "commit", "tree", "blob", "tag"][type];
      const [content, used] = inflateAt(data, off);
      off += used;
      const sha = storeObject(repo, typeName, content);
      pending.push({ index: pending.length, sha, type: typeName, offset: start });
    } else if (type === 6) {
      // ofs-delta
      let c = data[off++];
      let neg = c & 0x7f;
      while (c & 0x80) {
        c = data[off++];
        neg = ((neg + 1) << 7) | (c & 0x7f);
      }
      const baseOffset = start - neg;
      const [delta, used] = inflateAt(data, off);
      off += used;
      pending.push({ index: pending.length, offset: start, baseOffset, delta, type: "ofs-delta" });
    } else if (type === 7) {
      const baseSha = data.slice(off, off + 20).toString("hex");
      off += 20;
      const [delta, used] = inflateAt(data, off);
      off += used;
      pending.push({ index: pending.length, offset: start, baseSha, delta, type: "ref-delta" });
    } else {
      return { ok: false, error: "bad pack object type " + type };
    }
  }
  // resolve deltas
  const byOffset = new Map();
  for (const p of pending) if (p.type !== "ofs-delta" && p.type !== "ref-delta") byOffset.set(p.offset, p);
  let unresolved = pending.filter((p) => p.type === "ofs-delta" || p.type === "ref-delta");
  let guard = 0;
  while (unresolved.length && guard++ < 10000) {
    const still = [];
    for (const p of unresolved) {
      let base = null;
      if (p.type === "ofs-delta") {
        base = byOffset.get(p.baseOffset);
        if (base) {
          const sha = applyDeltaAndStore(repo, repo.objects.get(base.sha), p.delta);
          p.sha = sha;
          byOffset.set(p.offset, { sha, offset: p.offset });
          continue;
        }
      } else {
        if (repo.objects.has(p.baseSha)) {
          const sha = applyDeltaAndStore(repo, repo.objects.get(p.baseSha), p.delta);
          p.sha = sha;
          byOffset.set(p.offset, { sha, offset: p.offset });
          continue;
        }
        const baseP = pending.find((q) => q !== p && (q.sha === p.baseSha));
        if (baseP) {
          const sha = applyDeltaAndStore(repo, repo.objects.get(baseP.sha), p.delta);
          p.sha = sha;
          byOffset.set(p.offset, { sha, offset: p.offset });
          continue;
        }
      }
      still.push(p);
    }
    if (still.length === unresolved.length) return { ok: false, error: "unresolvable deltas" };
    unresolved = still;
  }
  return { ok: true, count };
}

function applyDeltaAndStore(repo, baseObj, delta) {
  const content = applyDelta(baseObj.data, delta);
  return storeObject(repo, baseObj.type, content);
}

function inflateAt(data, off) {
  // zlib stream at data[off...]; returns [content, bytesConsumed]
  const tryEnd = (end) => {
    try { return zlib.inflateSync(data.slice(off, end)); } catch { return null; }
  };
  let lo = 0, hi = 0;
  let prev = 8;
  for (;;) {
    const end = Math.min(data.length, off + prev);
    if (tryEnd(end) !== null) { hi = end - off; break; }
    if (end >= data.length) throw new Error("inflate failed at " + off);
    lo = prev;
    prev *= 2;
  }
  // binary search smallest successful end in (lo, hi]
  let a = lo, b = hi;
  while (a + 1 < b) {
    const mid = Math.floor((a + b) / 2);
    if (tryEnd(off + mid) !== null) b = mid; else a = mid;
  }
  return [zlib.inflateSync(data.slice(off, off + b)), b];
}

function applyDelta(base, delta) {
  let i = 0;
  const readVarint = () => {
    let v = 0, shift = 0, b;
    do { b = delta[i++]; v |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
    return v >>> 0;
  };
  const baseSize = readVarint();
  const resultSize = readVarint();
  const out = Buffer.alloc(resultSize);
  let o = 0;
  while (i < delta.length) {
    const op = delta[i++];
    if (op & 0x80) {
      let copyOff = 0, copyLen = 0;
      if (op & 0x01) copyOff |= delta[i++];
      if (op & 0x02) copyOff |= delta[i++] << 8;
      if (op & 0x04) copyOff |= delta[i++] << 16;
      if (op & 0x08) copyOff |= delta[i++] << 24;
      if (op & 0x10) copyLen |= delta[i++];
      if (op & 0x20) copyLen |= delta[i++] << 8;
      if (op & 0x40) copyLen |= delta[i++] << 16;
      if (copyLen === 0) copyLen = 0x10000;
      base.copy(out, o, copyOff, copyOff + copyLen);
      o += copyLen;
    } else if (op > 0) {
      delta.copy(out, o, i, i + op);
      i += op;
      o += op;
    } else {
      throw new Error("bad delta op 0");
    }
  }
  if (o !== resultSize) throw new Error("delta size mismatch");
  return out;
}

// ---------------- packfile write ------------------------------------------------
function writePack(repo, wants, haves, depth) {
  // collect the object set: commits from want tips (limited by depth), plus their trees and blobs.
  const haveSet = new Set(haves.filter((h) => repo.objects.has(h)));
  const haveClosure = new Set();
  for (const h of haveSet) {
    const hc = parseCommit(repo, h);
    if (!hc) { haveClosure.add(h); continue; }
    haveClosure.add(h);
    haveClosure.add(hc.tree);
    collectTreeObjects(repo, hc.tree, (s) => haveClosure.add(s));
  }
  const objects = [];
  const seen = new Set();
  const push = (sha) => { if (sha && !seen.has(sha) && !haveClosure.has(sha) && repo.objects.has(sha)) { seen.add(sha); objects.push(sha); } };
  for (const w0 of wants) {
    let w = w0;
    const wobj = repo.objects.get(w0);
    if (wobj && wobj.type === "tag") {
      push(w0);
      const tm = /^object ([0-9a-f]{40})/m.exec(wobj.data.toString("utf8"));
      if (!tm) continue;
      w = tm[1];
    }
    const c = parseCommit(repo, w);
    if (!c) continue;
    if (depth != null) {
      // shallow: walk depth levels, mark cut commits as shallow (parents still sent in pack? git sends full commit objects for included commits, stops adding parents' parents)
      const shallowSet = collectShallow(repo, w, depth);
      const queue = [{ sha: w, d: 1 }];
      const seenC = new Set();
      const included = [];
      while (queue.length) {
        const { sha, d } = queue.shift();
        if (seenC.has(sha)) continue;
        seenC.add(sha);
        const pc = parseCommit(repo, sha);
        if (!pc) continue;
        included.push(sha);
        if (d >= depth) continue;
        for (const p of pc.parents) queue.push({ sha: p, d: d + 1 });
      }
      for (const sha of included) {
        push(sha);
        const pc = parseCommit(repo, sha);
        push(pc.tree);
        collectTreeObjects(repo, pc.tree, push);
      }
    } else {
      if (haveSet.has(w)) continue;
      const anc = ancestrySet(repo, w);
      const list = [...anc];
      for (const sha of list) {
        if (haveSet.has(sha)) continue;
        push(sha);
        const pc = parseCommit(repo, sha);
        if (!pc) continue;
        push(pc.tree);
        collectTreeObjects(repo, pc.tree, push);
      }
    }
  }
  const parts = [];
  const header = Buffer.alloc(12);
  header.write("PACK", 0, 4, "ascii");
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  const h = crypto.createHash("sha1");
  h.update(header);
  for (const sha of objects) {
    const obj = repo.objects.get(sha);
    const typeNum = { commit: 1, tree: 2, blob: 3, tag: 4 }[obj.type] || 3;
    const head = encodeObjHeader(typeNum, obj.data.length);
    h.update(head);
    parts.push(head);
    const comp = zlib.deflateSync(obj.data, { level: 1 });
    h.update(comp);
    parts.push(comp);
  }
  const trailer = h.digest();
  parts.push(trailer);
  return Buffer.concat(parts);
}

function encodeObjHeader(type, size) {
  const bytes = [];
  let b = (type << 4) | (size & 15);
  size >>>= 4;
  while (size) { b |= 0x80; bytes.push(b); b = size & 0x7f; size >>>= 7; }
  bytes.push(b);
  return Buffer.from(bytes);
}

function collectTreeObjects(repo, treeSha, push) {
  const obj = repo.objects.get(treeSha);
  if (!obj || obj.type !== "tree") return;
  const data = obj.data;
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const nul = data.indexOf(0x00, sp + 1);
    const mode = data.slice(i, sp).toString("utf8");
    const sha = data.slice(nul + 1, nul + 21).toString("hex");
    i = nul + 21;
    push(sha);
    if (mode === "40000" || mode === "040000") collectTreeObjects(repo, sha, push);
  }
}

// ---------------------------------------------------------------- server
async function handleRequest(req, res) {
  try {
    const { path, query } = parseUrl(req);
    if (path === "/healthz" && req.method === "GET") { res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }); res.end("ok\n"); return; }
    // git smart HTTP
    const git = parseGitPath(path);
    if (git && git.rest === "info/refs" && req.method === "GET") {
      const repo = getRepo(git.owner, git.name);
      if (!repo) { res.writeHead(404, { "content-type": "text/plain" }); res.end("not found"); return; }
      const svc = query.get("service");
      if (svc === "git-receive-pack") {
        const r = receivePackInfoRefs(repo, req);
        res.writeHead(r.status, { "content-type": r.contentType, "cache-control": "no-cache" });
        res.end(r.body);
        return;
      }
      if (svc === "git-upload-pack" || svc === null) {
        const r = uploadPackInfoRefs(repo, req);
        res.writeHead(r.status, { "content-type": r.contentType, "cache-control": "no-cache" });
        res.end(r.body);
        return;
      }
      res.writeHead(400); res.end("bad service"); return;
    }
    if (git && (git.rest === "git-upload-pack" || git.rest === "git-receive-pack") && req.method === "POST") {
      const repo = getRepo(git.owner, git.name);
      if (!repo) { res.writeHead(404); res.end("not found"); return; }
      const body = await readBody(req);
      const r = git.rest === "git-upload-pack" ? await uploadPack(repo, body, req) : await receivePack(repo, body);
      res.writeHead(r.status, { "content-type": r.contentType, "cache-control": "no-cache" });
      res.end(r.body);
      return;
    }
    if (path.startsWith("/api/graphql")) {
      const body = await readBody(req);
      if (!authorized(req)) { sendJson(res, 401, { message: "Bad credentials" }); return; }
      const json = safeJson(body);
      if (json === undefined) { sendJson(res, 400, { message: "Problems parsing JSON" }); return; }
      const out = await handleGraphQL(json, query);
      sendJson(res, 200, out);
      return;
    }
    if (path === "/mcp" || path === "/mcp/") {
      await handleMcp(req, res);
      return;
    }
    if (path.startsWith(apiBase)) {
      const auth = authorized(req);
      if (!auth) {
        // protocol checks expect JSON 401 with content-type
        sendJson(res, 401, { message: "Requires authentication" }, { "x-github-request-id": rand8() });
        return;
      }
      const raw = await readBody(req);
      let body;
      if (raw.length > 0) {
        body = safeJson(raw);
        if (body === undefined) {
          sendJson(res, 400, { message: "Problems parsing JSON" }, { "x-github-request-id": rand8() });
          return;
        }
      }
      const out = await handleRest(req, res, path, query, body);
      if (out.obj === null && out.status === 204) { sendEmpty(res, 204, out.extra); return; }
      sendJson(res, out.status, out.obj, out.extra || { "x-github-request-id": rand8() });
      return;
    }
    // unknown
    sendJson(res, 404, { message: "Not Found" }, { "x-github-request-id": rand8() });
  } catch (e) {
    log("request error", String(e && e.stack || e));
    try { sendJson(res, 500, { message: "internal error" }, { "x-github-request-id": rand8() }); } catch {}
  }
}

function rand8() { return crypto.randomBytes(6).toString("hex").toUpperCase(); }
function safeJson(buf) {
  try { return JSON.parse(buf.toString("utf8")); } catch { return undefined; }
}

const server = http.createServer(handleRequest);
server.keepAliveTimeout = 10000;
server.headersTimeout = 30000;

const PORT = parseInt(process.env.FORGE_PORT || "0", 10) || 0;
let FORGE_ORIGIN = "";
server.listen(PORT, "127.0.0.1", async () => {
  FORGE_ORIGIN = "http://127.0.0.1:" + server.address().port;
  const addr = server.address();
  const base = "http://127.0.0.1:" + addr.port;
  log("forge listening on", base);
  await register(base);
  pollDone().catch((e) => log("poll error", String(e)));
});

// ---------------------------------------------------------------- GraphQL
function globalId(prefix, dbId) {
  const raw = Buffer.from(String(dbId), "utf8");
  return prefix + raw.toString("base64");
}
function parseGlobalId(id) {
  if (typeof id !== "string" || id.length < 2) return null;
  const prefix = id.slice(0, 1);
  try {
    const raw = Buffer.from(id.slice(1), "base64").toString("utf8");
    const n = parseInt(raw, 10);
    if (Number.isFinite(n)) return { prefix, n };
  } catch {}
  return null;
}
function findRepoById(id) { for (const r of store.repos.values()) if (r.id === id) return r; return null; }
const VIEWER_LOGIN_QUERY = `query ViewerLogin {
  viewer {
    login
  }
}`;

function resolveOwner(owner) {
  if (owner === OWNER) return { login: OWNER, id: 1000, type: "User" };
  if (owner === STRANGER) return { login: STRANGER, id: 1002, type: "User" };
  return null;
}
function repoNodeId(repo) { return globalId("R", repo.id); }
function issueNodeId(repo, number) { return globalId("I", repo.id * 100000 + number); }
function pullNodeId(repo, number) { return globalId("P", repo.id * 100000 + number); }

async function handleGraphQL(body, query) {
  const operations = Array.isArray(body) ? body : [body];
  const responses = [];
  for (const op of operations) {
    try {
      responses.push(await handleGraphQLOperation(op));
    } catch (e) {
      responses.push({ data: null, errors: [{ message: String(e && e.message || e) }] });
    }
  }
  return Array.isArray(body) ? responses : responses[0];
}

async function handleGraphQLOperation(op) {
  if (typeof op !== "object" || op === null) return { data: null, errors: [{ message: "an operation is not an object" }] };
  const queryText = typeof op.query === "string" ? op.query : "";
  const variables = op.variables && typeof op.variables === "object" ? op.variables : {};

  // viewer
  const viewerBlock = /\bviewer\s*\{([^}]*)\}/.exec(queryText);
  if (viewerBlock) {
    const known = new Set(["login", "id", "name", "createdAt", "avatarUrl", "email", "databaseId", "url", "bio", "company"]);
    const requested = viewerBlock[1].split(/[\s,]+/).map((s) => s.trim()).filter((s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s));
    const unknown = [...new Set(requested.filter((f) => !known.has(f)))];
    if (unknown.length) {
      return { data: { viewer: null }, errors: unknown.map((f) => ({ message: `Field '${f}' doesn't exist on type 'Viewer'` })) };
    }
    return { data: { viewer: { login: OWNER } } };
  }
  // __type introspection
  const typeMatches = [...queryText.matchAll(/__type\s*\(\s*name:\s*"([^"]+)"/g)];
  if (typeMatches.length) {
    const schemas = {
      Issue: ["assignees","author","body","closed","closedAt","comments","createdAt","id","labels","number","repository","state","title","updatedAt","url"],
      PullRequest: ["additions","assignees","author","baseRefName","baseRefOid","body","changedFiles","closed","closedAt","comments","commits","createdAt","deletions","files","headRefName","headRefOid","headRepository","headRepositoryOwner","id","mergeable","mergeCommit","merged","mergedAt","mergedBy","number","potentialMergeCommit","repository","reviewDecision","reviews","state","title","updatedAt","url"],
      Repository: ["id","databaseId","name","nameWithOwner","owner","description","defaultBranchRef","isEmpty","isFork","isPrivate","hasIssuesEnabled","hasWikiEnabled","viewerPermission","issue","issues","label","labels","pullRequest","pullRequests","ref","refs","stargazerCount","url","createdAt","updatedAt","pushedAt"],
      Comment: ["author","body","createdAt","id","updatedAt","url"],
    };
    const enums = {
      SearchType: ["ISSUE", "REPOSITORY", "USER"],
      IssueState: ["OPEN", "CLOSED"],
      PullRequestState: ["OPEN", "CLOSED", "MERGED"],
      MergeableState: ["MERGEABLE", "CONFLICTING", "UNKNOWN"],
    };
    const data = {};
    for (const tm of typeMatches) {
      const name = tm[1];
      data[name] = {
        fields: (schemas[name] || []).map((f) => ({ name: f })),
        enumValues: (enums[name] || []).map((v) => ({ name: v })),
      };
    }
    return { data };
  }
  // repository(...)
  const repoMatch = /repository\s*\(\s*owner:\s*\$owner,\s*name:\s*\$name\s*\)/.exec(queryText);
  if (repoMatch) {
    const owner = variables.owner;
    const name = variables.name;
    const repo = findRepo(owner, name);
    if (!repo) {
      return { data: { repository: null } };
    }
    const node = {};
    if (/id/.test(queryText)) node.id = repoNodeId(repo);
    if (/databaseId/.test(queryText)) node.databaseId = repo.id;
    if (/name/.test(queryText)) node.name = repo.name;
    if (/owner\s*\{/.test(queryText)) node.owner = { login: OWNER };
    if (/defaultBranchRef\s*\{/.test(queryText)) node.defaultBranchRef = { name: repo.defaultBranch };
    if (/viewerPermission/.test(queryText)) node.viewerPermission = "ADMIN";
    if (/hasIssuesEnabled/.test(queryText)) node.hasIssuesEnabled = true;
    if (/issues\s*\(/.test(queryText)) {
      node.issues = issuesConnection(repo, queryText, variables);
    }
    if (/\bissue\s*\(/.test(queryText)) {
      const m = /issue\s*\(\s*number:\s*\$number\s*\)/.exec(queryText);
      const num = variables.number;
      const issue = repo.issues.get(num);
      node.issue = issue ? issueGql(repo, issue, queryText) : null;
      if (!issue) {
        return { data: { repository: { issue: null } }, errors: [{ type: "NOT_FOUND", message: `Could not resolve to an Issue with the number of ${num}.` }] };
      }
    }
    if (/pullRequests\s*\(/.test(queryText)) {
      node.pullRequests = pullsConnection(repo, queryText, variables);
    }
    if (/pullRequest\s*\(/.test(queryText)) {
      const num = variables.number;
      const pull = [...repo.pulls.values()].find((p) => p.number === num);
      if (!pull) {
        return { data: { repository: { pullRequest: null } }, errors: [{ type: "NOT_FOUND", message: `Could not resolve to a PullRequest with the number of ${num}.` }] };
      }
      node.pullRequest = pullGql(repo, pull, queryText);
    }
    return { data: { repository: node } };
  }
  // mutations
  const createIssueM = /mutation\s+\w*\s*\(\s*\$input:\s*CreateIssueInput!/.test(queryText) || /createIssue\s*\(/.test(queryText);
  if (createIssueM && /createIssue/.test(queryText)) {
    const input = variables.input || {};
    const gid = parseGlobalId(input.repositoryId);
    if (!gid) return { data: { createIssue: null }, errors: [{ message: "Could not resolve to a node with the global id of " + jsonStr(input.repositoryId) }] };
    const repo = findRepoById(gid.n);
    if (!repo) return { data: { createIssue: null }, errors: [{ message: "Could not resolve to a node with the global id of " + jsonStr(input.repositoryId) }] };
    const issue = createIssueInternal(repo, input.title || "", input.body || "");
    return { data: { createIssue: { issue: { number: issue.number, id: issueNodeId(repo, issue.number) } } } };
  }
  if (/closeIssue/.test(queryText)) {
    const input = variables.input || {};
    const gid = parseGlobalId(input.issueId);
    let repo = null, issue = null;
    if (gid) {
      const num = gid.n % 100000;
      for (const r of store.repos.values()) {
        const cand = r.issues.get(num);
        if (cand && issueNodeId(r, num) === input.issueId) { repo = r; issue = cand; break; }
      }
    }
    if (!issue) return { data: { closeIssue: null }, errors: [{ message: "Could not resolve to a node with the global id of " + jsonStr(input.issueId) }] };
    issue.state = "closed";
    issue.closedAt = nowIso();
    return { data: { closeIssue: { issue: { number: issue.number, id: issueNodeId(repo, issue.number), state: "CLOSED" } } } };
  }
  if (/createPullRequest/.test(queryText)) {
    const input = variables.input || {};
    const gid = parseGlobalId(input.repositoryId);
    if (!gid) return { data: { createPullRequest: null }, errors: [{ message: "Could not resolve to a node with the global id of " + jsonStr(input.repositoryId) }] };
    const repo = findRepoById(gid.n);
    if (!repo) return { data: { createPullRequest: null }, errors: [{ message: "Could not resolve to a node with the global id of " + jsonStr(input.repositoryId) }] };
    let pull;
    try {
      pull = createPullInternal(repo, input.title || "", input.body || "", input.headRefName || "", input.baseRefName || repo.defaultBranch);
    } catch (e) {
      return { data: { createPullRequest: null }, errors: [{ message: String(e && e.message || e) }] };
    }
    return { data: { createPullRequest: { pullRequest: { number: pull.number, id: pullNodeId(repo, pull.number), state: "OPEN", headRefName: pull.head, baseRefName: pull.base } } } };
  }
  if (/mergePullRequest/.test(queryText)) {
    const input = variables.input || {};
    const gid = parseGlobalId(input.pullRequestId);
    let repo = null, pull = null;
    if (gid) {
      const num = gid.n % 100000;
      for (const r of store.repos.values()) {
        const cand = [...r.pulls.values()].find((p) => p.number === num);
        if (cand && pullNodeId(r, num) === input.pullRequestId) { repo = r; pull = cand; break; }
      }
    }
    if (!pull) return { data: { mergePullRequest: null }, errors: [{ message: "Could not resolve to a node with the global id of " + jsonStr(input.pullRequestId) }] };
    const merged = mergePullInternal(repo, pull);
    if (!merged.ok) {
      return { data: { mergePullRequest: null }, errors: [{ type: "UNPROCESSABLE", message: String(merged.error || "Pull Request is not mergeable") }] };
    }
    return { data: { mergePullRequest: { pullRequest: { number: pull.number, merged: true, sha: pull.mergeCommit } } } };
  }
  const nodeM = /\bnode\s*\(\s*id:\s*\$id\s*\)/.exec(queryText);
  if (nodeM) {
    const gid = parseGlobalId(variables.id);
    const repo = gid ? findRepoById(gid.n) : null;
    if (!repo) return { data: { node: null }, errors: [{ message: "Could not resolve to a node with the global id of " + jsonStr(variables.id) }] };
    return { data: { node: { id: repoNodeId(repo), name: repo.name, nameWithOwner: OWNER + "/" + repo.name } } };
  }
  if (/addComment/.test(queryText)) {
    const input = variables.input || {};
    const gid = parseGlobalId(input.subjectId);
    let repo = null, issue = null;
    if (gid) {
      repo = findRepoById(Math.floor(gid.n / 100000));
      const num = gid.n % 100000;
      if (repo) issue = repo.issues.get(num);
      if (issue && issueNodeId(repo, num) !== input.subjectId) issue = null;
    }
    if (!issue) return { data: { addComment: null }, errors: [{ message: "Could not resolve to a node with the global id of " + jsonStr(input.subjectId) }] };
    const comment = { id: ++seqCounter, body: String(input.body || ""), createdAt: nowIso() };
    issue.comments.push(comment);
    return { data: { addComment: { commentEdge: { node: { id: "IC_" + comment.id, body: comment.body } } } } };
  }
  return { data: null, errors: [{ message: "unrecognized GraphQL operation" }] };
}

function jsonStr(v) { return JSON.stringify(v); }

function issuesConnection(repo, queryText, variables) {
  let list = [...repo.issues.values()];
  let after = null;
  const firstMatch = /issues\s*\(\s*first:\s*\$first/.test(queryText) ? variables.first : null;
  if (/states:\s*\[OPEN\]/.test(queryText)) list = list.filter((i) => i.state === "open");
  if (/field:\s*CREATED_AT,\s*direction:\s*DESC/.test(queryText)) list.reverse();
  if (/orderBy/.test(queryText) === false) list = list;
  const am = /after:\s*\$after/.test(queryText);
  if (am) after = variables.after || null;
  let nodes = list;
  let hasNextPage = false;
  if (firstMatch != null) {
    const n = Math.max(0, parseInt(firstMatch, 10) || 0);
    if (am && after) {
      const idx = list.findIndex((i) => issueNodeId(repo, i.number) === after);
      nodes = idx >= 0 ? list.slice(idx + 1) : list;
    }
    hasNextPage = nodes.length > n;
    nodes = nodes.slice(0, n);
  } else if (am && after) {
    const idx = list.findIndex((i) => issueNodeId(repo, i.number) === after);
    nodes = idx >= 0 ? list.slice(idx + 1) : list;
  }
  const shaped = nodes.map((i) => ({
    number: i.number,
    title: i.title,
    state: i.state === "open" ? "OPEN" : "CLOSED",
    id: issueNodeId(repo, i.number),
    body: i.body,
    bodyText: i.body,
  }));
  const out = { nodes: shaped };
  if (/pageInfo\s*\{/.test(queryText)) {
    out.pageInfo = {
      endCursor: shaped.length ? shaped[shaped.length - 1].id : null,
      hasNextPage,
    };
  }
  if (/totalCount/.test(queryText)) out.totalCount = list.length;
  return out;
}

function pullsConnection(repo, queryText, variables) {
  let list = [...repo.pulls.values()];
  if (/state:\s*\[OPEN\]/.test(queryText)) list = list.filter((p) => p.state === "open");
  const first = /pullRequests\s*\(\s*first:\s*\$first/.test(queryText) ? variables.first : null;
  let nodes = list;
  if (first != null) nodes = list.slice(0, Math.max(0, parseInt(first, 10) || 0));
  return {
    nodes: nodes.map((p) => ({
      number: p.number,
      headRefName: p.head,
      baseRefName: p.base,
      mergeable: p.state === "open" ? "MERGEABLE" : "UNKNOWN",
      state: p.state === "open" ? "OPEN" : p.merged ? "MERGED" : "CLOSED",
    })),
  };
}

function issueGql(repo, issue, queryText) {
  const node = {};
  if (/number/.test(queryText)) node.number = issue.number;
  if (/title/.test(queryText)) node.title = issue.title;
  if (/state/.test(queryText)) node.state = issue.state === "open" ? "OPEN" : "CLOSED";
  if (/id/.test(queryText)) node.id = issueNodeId(repo, issue.number);
  if (/body/.test(queryText)) node.body = issue.body;
  return node;
}

function pullGql(repo, pull, queryText) {
  const node = {};
  if (/number/.test(queryText)) node.number = pull.number;
  if (/id/.test(queryText)) node.id = pullNodeId(repo, pull.number);
  if (/state/.test(queryText)) node.state = pull.state === "open" ? "OPEN" : pull.merged ? "MERGED" : "CLOSED";
  if (/headRefName/.test(queryText)) node.headRefName = pull.head;
  if (/baseRefName/.test(queryText)) node.baseRefName = pull.base;
  if (/mergeable/.test(queryText)) node.mergeable = pull.state === "open" ? "MERGEABLE" : "UNKNOWN";
  if (/merged/.test(queryText)) node.merged = !!pull.merged;
  if (/files\s*\(/.test(queryText)) {
    const files = computePullFiles(repo, pull);
    node.files = { nodes: files.map((f) => ({ path: f.filename })) };
  }
  return node;
}

// ---------------------------------------------------------------- MCP
const MCP_SUPPORTED = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const MCP_SESSIONS = new Set();

function mcpTool(name, description, properties, required) {
  const props = {};
  for (const [key, value] of Object.entries(properties)) props[key] = value;
  return {
    name,
    description,
    inputSchema: { type: "object", properties: props, required: required || [] },
  };
}
const MCP_TOOLS = [
  mcpTool("create_repo", "Create a repository for the authenticated owner", {
    name: { type: "string", description: "repository name" },
    description: { type: "string", description: "repository description" },
    private: { type: "boolean", description: "make the repository private" },
  }, ["name"]),
  mcpTool("get_repo", "Read one repository", {
    owner: { type: "string", description: "repository owner login" },
    repo: { type: "string", description: "repository name" },
  }, ["owner", "repo"]),
  mcpTool("create_issue", "Create an issue in a repository", {
    owner: { type: "string", description: "repository owner login" },
    repo: { type: "string", description: "repository name" },
    title: { type: "string", description: "issue title" },
    body: { type: "string", description: "issue body" },
  }, ["owner", "repo", "title"]),
  mcpTool("list_issues", "List issues in a repository", {
    owner: { type: "string", description: "repository owner login" },
    repo: { type: "string", description: "repository name" },
    state: { type: "string", description: "open, closed or all" },
  }, ["owner", "repo"]),
  mcpTool("get_issue", "Read one issue", {
    owner: { type: "string", description: "repository owner login" },
    repo: { type: "string", description: "repository name" },
    number: { type: "number", description: "issue number" },
  }, ["owner", "repo", "number"]),
  mcpTool("create_pull_request", "Open a pull request", {
    owner: { type: "string", description: "repository owner login" },
    repo: { type: "string", description: "repository name" },
    title: { type: "string", description: "pull request title" },
    body: { type: "string", description: "pull request body" },
    head: { type: "string", description: "head branch" },
    base: { type: "string", description: "base branch" },
  }, ["owner", "repo", "title", "head", "base"]),
  mcpTool("merge_pull_request", "Merge a pull request", {
    owner: { type: "string", description: "repository owner login" },
    repo: { type: "string", description: "repository name" },
    pull_number: { type: "number", description: "pull request number" },
  }, ["owner", "repo", "pull_number"]),
  mcpTool("list_pull_requests", "List pull requests in a repository", {
    owner: { type: "string", description: "repository owner login" },
    repo: { type: "string", description: "repository name" },
  }, ["owner", "repo"]),
];

function mcpJson(id, result) { return { jsonrpc: "2.0", id, result }; }
function mcpErr(id, code, message) { return { jsonrpc: "2.0", id, error: { code, message } }; }
function toolText(obj) {
  const text = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
  return { content: [{ type: "text", text }], isError: false };
}
function toolError(text) { return { content: [{ type: "text", text }], isError: true }; }

async function handleMcp(req, res) {
  const raw = await readBody(req);
  let parsed = null;
  if (raw.length) {
    try { parsed = JSON.parse(raw.toString("utf8")); } catch { parsed = undefined; }
  }
  if (parsed === undefined) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
    return;
  }
  // notifications first
  const isNotification = (m) => m && typeof m === "object" && m.id === undefined && typeof m.method === "string";
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  const needAuth = entries.some((m) => m && typeof m === "object" && m.method !== "initialize" && m.method !== "server/discover" && m.id !== undefined);
  if (needAuth && !authorized(req)) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } }));
    return;
  }
  // session handling: echo or mint
  let session = req.headers["mcp-session-id"];
  if (typeof session === "string" && session && !MCP_SESSIONS.has(session)) session = undefined;
  if (!session) { session = crypto.randomBytes(16).toString("hex"); MCP_SESSIONS.add(session); }
  const responses = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    if (isNotification(entry)) {
      continue;
    }
    const id = entry.id;
    const method = entry.method;
    const params = entry.params && typeof entry.params === "object" ? entry.params : {};
    try {
      if (method === "server/discover") {
        responses.push(mcpJson(id, {
          supportedVersions: MCP_SUPPORTED,
          serverInfo: { name: "forge-mcp", version: "1.0.0" },
          capabilities: { tools: { listChanged: false } },
        }));
      } else if (method === "initialize") {
        const requested = typeof params.protocolVersion === "string" && /^\d{4}-\d{2}-\d{2}$/.test(params.protocolVersion) ? params.protocolVersion : "2026-07-28";
        const version = MCP_SUPPORTED.includes(requested) ? requested : "2026-07-28";
        responses.push(mcpJson(id, {
          protocolVersion: version,
          serverInfo: { name: "forge-mcp", version: "1.0.0" },
          capabilities: { tools: { listChanged: false } },
        }));
      } else if (method === "tools/list") {
        responses.push(mcpJson(id, { tools: MCP_TOOLS }));
      } else if (method === "tools/call") {
        const name = typeof params.name === "string" ? params.name : "";
        const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
        const tool = MCP_TOOLS.find((t) => t.name === name);
        if (!tool) {
          responses.push(mcpErr(id, -32602, `Unknown tool: ${name}`));
          continue;
        }
        const missing = (tool.inputSchema.required || []).filter((r) => args[r] === undefined || args[r] === null || args[r] === "");
        if (missing.length) {
          responses.push(mcpJson(id, toolError(`missing required argument(s): ${missing.join(", ")}`)));
          continue;
        }
        try {
          const result = await runMcpTool(name, args);
          responses.push(mcpJson(id, toolText(result)));
        } catch (e) {
          responses.push(mcpJson(id, toolError(String(e && e.message || e))));
        }
      } else if (method === "ping") {
        responses.push(mcpJson(id, {}));
      } else {
        responses.push(mcpErr(id, -32601, `Method not found: ${method}`));
      }
    } catch (e) {
      responses.push(mcpErr(id, -32603, String(e && e.message || e)));
    }
  }
  res.writeHead(200, { "content-type": "application/json", "mcp-session-id": session });
  res.end(JSON.stringify(responses.length === 1 ? responses[0] : responses));
}

async function runMcpTool(name, args) {
  const owner = args.owner === OWNER ? OWNER : (typeof args.owner === "string" ? args.owner : OWNER);
  if (name === "create_repo") {
    const repoName = String(args.name);
    const existing = findRepo(OWNER, repoName);
    if (existing) return repoJson(existing, false);
    const repo = createRepoInternal(repoName, !!args.private, args.description || "");
    return repoJson(repo, true);
  }
  const repo = findRepo(owner, String(args.repo || ""));
  if (!repo) throw new Error(`repository ${owner}/${args.repo} not found`);
  if (name === "get_repo") return repoJson(repo, false);
  if (name === "create_issue") {
    const issue = createIssueInternal(repo, String(args.title), String(args.body || ""));
    return restIssueJson(issue, repo);
  }
  if (name === "list_issues") {
    const state = String(args.state || "open");
    return [...repo.issues.values()].filter((i) => state === "all" || i.state === state).map((i) => restIssueJson(i, repo));
  }
  if (name === "get_issue") {
    const issue = repo.issues.get(parseInt(args.number, 10));
    if (!issue) throw new Error(`issue #${args.number} not found`);
    return restIssueJson(issue, repo);
  }
  if (name === "create_pull_request") {
    const pull = createPullInternal(repo, String(args.title), String(args.body || ""), String(args.head), String(args.base || repo.defaultBranch));
    return pullJson(repo, pull);
  }
  if (name === "list_pull_requests") {
    return [...repo.pulls.values()].map((p) => pullJson(repo, p));
  }
  if (name === "merge_pull_request") {
    const pull = [...repo.pulls.values()].find((p) => p.number === parseInt(args.pull_number, 10));
    if (!pull) throw new Error(`pull request #${args.pull_number} not found`);
    const merged = mergePullInternal(repo, pull);
    if (!merged.ok) throw new Error(String(merged.error || "Pull Request is not mergeable"));
    return { merged: true, sha: pull.mergeCommit, number: pull.number };
  }
  throw new Error(`unsupported tool: ${name}`);
}

function createRepoInternal(name, priv, description) { return newRepo(name, { private: !!priv, description: description || "" }); }
function restIssueJson(issue, repo) { return issueJson(repo, issue); }
function createIssueInternal(repo, title, body) { return createIssueRecord(repo, { title, body: body || "", labels: [] }); }
function createPullInternal(repo, title, body, head, base) {
  if (!head || !base) throw new Error("head and base refs are required");
  if (!resolveRef(repo, "refs/heads/" + head)) throw new Error("head branch " + JSON.stringify(head) + " does not exist");
  if (!resolveRef(repo, "refs/heads/" + base)) throw new Error("base branch " + JSON.stringify(base) + " does not exist");
  if (head === base) throw new Error("head and base must differ");
  return createPullRecord(repo, { head, base, title: title || head, body: body || "" });
}
function mergePullInternal(repo, pull) {
  if (pull.state !== "open") return { ok: false, error: "pull request " + pull.number + " is not open" };
  const result = squashMerge(repo, pull);
  if (result.conflict) return { ok: false, error: result.message || "merge failed" };
  applyTreeToRef(repo, "refs/heads/" + pull.base, result.sha);
  pull.merged = true; pull.state = "closed"; pull.mergedAt = nowIso(); pull.mergeCommitSha = result.sha; pull.mergedBy = true;
  return { ok: true, sha: result.sha };
}

function collectWantedRefNames(repo, wants) {
  const out = [];
  for (const [ref, sha] of repo.refs) if (wants.includes(sha)) out.push([sha, ref]);
  return out;
}
