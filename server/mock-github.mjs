/* ============================================================
 * 本地测试用的"假 GitHub"：只实现 write-api.js 用到的那几个接口
 * 目的：在没有真实 token、不碰用户仓库的前提下，验证并发写入不会互相覆盖
 * ============================================================ */

const b64 = (str) => Buffer.from(str, "utf8").toString("base64");
const unb64 = (s) => Buffer.from(s, "base64").toString("utf8");

export function installMockGitHub({ owner = "o", repo = "r", branch = "main" } = {}) {
  const files = new Map();        // path -> content(string)
  const blobs = new Map();        // sha -> base64 content
  const trees = new Map();        // sha -> Map(path -> content)
  const commits = new Map();      // sha -> { tree, parents }
  const commitLog = [];           // 提交顺序
  let counter = 0;
  const newSha = (tag) => `${tag}${String(++counter).padStart(4, "0")}`;

  /* 初始提交：空仓库里先放一个占位文件 */
  files.set("README.md", "# data repo");
  const t0 = newSha("tree");
  trees.set(t0, new Map(files));
  const c0 = newSha("commit");
  commits.set(c0, { tree: t0, parents: [] });
  commitLog.push({ sha: c0, message: "(init)", files: new Set(files.keys()) });
  let ref = c0;

  /** 让外部在下次更新 ref 之前插入一次"别人的提交"，用来制造冲突 */
  let beforeRefUpdate = null;

  const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  });

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    const method = ((init && init.method) || (typeof input === "object" && input.method) || "GET").toUpperCase();
    const bodyText = init && typeof init.body === "string" ? init.body : (typeof input === "object" && input.body ? String(input.body) : "");
    const prefix = `https://api.github.com/repos/${owner}/${repo}`;
    if (!url.startsWith(prefix)) return realFetch(input, init);
    const rest = url.slice(prefix.length);
    const [rawPath, query] = rest.split("?");
    const body = bodyText ? JSON.parse(bodyText) : {};

    /* ---- Contents API：读文件 ---- */
    let m = rawPath.match(/^\/contents\/(.+)$/);
    if (m && method === "GET") {
      const path = decodeURI(m[1]);
      if (!files.has(path)) return json({ message: "Not Found" }, 404);
      const content = files.get(path);
      const sha = newSha("blob");
      blobs.set(sha, b64(content));
      return json({ name: path.split("/").pop(), path, sha, size: content.length, encoding: "base64", content: b64(content) });
    }
    /* ---- Blobs ---- */
    if (rawPath === "/git/blobs" && method === "POST") {
      const sha = newSha("blob");
      blobs.set(sha, body.content);
      return json({ sha });
    }
    m = rawPath.match(/^\/git\/blobs\/(.+)$/);
    if (m && method === "GET") {
      if (!blobs.has(m[1])) return json({ message: "Not Found" }, 404);
      return json({ sha: m[1], content: blobs.get(m[1]), encoding: "base64" });
    }
    /* ---- 分支 ref ---- */
    m = rawPath.match(/^\/git\/ref\/heads\/(.+)$/);
    if (m && method === "GET") return json({ ref: `refs/heads/${m[1]}`, object: { sha: ref } });
    /* ---- 提交 ---- */
    m = rawPath.match(/^\/git\/commits\/(.+)$/);
    if (m && method === "GET") {
      if (!commits.has(m[1])) return json({ message: "Not Found" }, 404);
      return json({ sha: m[1], tree: { sha: commits.get(m[1]).tree }, parents: commits.get(m[1]).parents.map((p) => ({ sha: p })) });
    }
    if (rawPath === "/git/commits" && method === "POST") {
      const sha = newSha("commit");
      commits.set(sha, { tree: body.tree, parents: body.parents || [] });
      commitLog.push({ sha, message: body.message, files: new Set() });
      return json({ sha, tree: { sha: body.tree } });
    }
    /* ---- tree ---- */
    if (rawPath === "/git/trees" && method === "POST") {
      const base = body.base_tree && trees.has(body.base_tree) ? trees.get(body.base_tree) : new Map();
      const next = new Map(base);
      for (const entry of body.tree || []) {
        if (entry.sha === null) next.delete(entry.path);
        else if (blobs.has(entry.sha)) next.set(entry.path, unb64(blobs.get(entry.sha)));
        else return json({ message: "unknown blob " + entry.sha }, 422);
      }
      const sha = newSha("tree");
      trees.set(sha, next);
      return json({ sha });
    }
    /* ---- 更新 ref：只允许 fast-forward ---- */
    m = rawPath.match(/^\/git\/refs\/heads\/(.+)$/);
    if (m && method === "PATCH") {
      if (typeof beforeRefUpdate === "function") {
        const hook = beforeRefUpdate;
        beforeRefUpdate = null;
        await hook();                                    /* 模拟"别人抢先提交" */
      }
      const target = commits.get(body.sha);
      if (!target || !target.parents.includes(ref)) {
        return json({ message: "Update is not a fast forward" }, 422);
      }
      ref = body.sha;
      files.clear();
      for (const [k, v] of trees.get(target.tree)) files.set(k, v);
      /* 记录本次提交改了哪些文件 */
      const last = commitLog[commitLog.length - 1];
      if (last && last.sha === body.sha) last.files = new Set(files.keys());
      return json({ ref: `refs/heads/${m[1]}`, object: { sha: ref } });
    }
    return json({ message: "mock: unhandled " + method + " " + rawPath }, 500);
  };

  return {
    files,
    commitLog,
    get commitCount() { return commitLog.length; },
    read(path) { return files.get(path); },
    json(path) { const t = files.get(path); return t ? JSON.parse(t) : null; },
    /** 按正常提交流程直接写一个文件（测试里用来造"老数据"） */
    commitPath(path, content, message = "(test)") {
      const tree = new Map(files);
      tree.set(path, content);
      const tSha = newSha("tree");
      trees.set(tSha, tree);
      const cSha = newSha("commit");
      commits.set(cSha, { tree: tSha, parents: [ref] });
      commitLog.push({ sha: cSha, message, files: new Set([path]) });
      ref = cSha;
      files.clear();
      for (const [k, v] of tree) files.set(k, v);
    },
    /** 安排一次冲突：下一次 ref 更新前，先用"别人"的身份提交一次 */
    injectConflict() {
      beforeRefUpdate = async () => {
        const foreign = files.get("state/wall.json") || "{}";
        const parsed = JSON.parse(foreign);
        parsed.memories = parsed.memories || [];
        if (parsed.memories[0]) parsed.memories[0].story = String(parsed.memories[0].story || "") + " [外人改动]";
        const tree = new Map(files);
        tree.set("state/wall.json", JSON.stringify(parsed));
        const tSha = newSha("tree");
        trees.set(tSha, tree);
        const cSha = newSha("commit");
        commits.set(cSha, { tree: tSha, parents: [ref] });
        commitLog.push({ sha: cSha, message: "(外人提交)", files: new Set() });
        ref = cSha;
        files.clear();
        for (const [k, v] of tree) files.set(k, v);
      };
    },
    restore() { globalThis.fetch = realFetch; },
  };
}
