/**
 * 静态文件服务器（仅测试用）：服务仓库根目录（本文件位于 test/ 下）
 */
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = Number(process.env.PORT || 8931);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".tif": "image/tiff",
  ".json": "application/json",
};

const server = http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p === "/") p = "/index.html";
    const path = normalize(join(ROOT, p));
    if (!path.startsWith(normalize(ROOT))) {
      res.writeHead(403).end();
      return;
    }
    const data = await readFile(path);
    res.writeHead(200, {
      "content-type": MIME[extname(path).toLowerCase()] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(data);
  } catch (err) {
    res.writeHead(404).end("not found");
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`static server on http://127.0.0.1:${PORT}/`);
});
