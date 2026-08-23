// 通过 CDP 直接控制已运行的浏览器下载文件（规避 agent-browser download 被取消的问题）
// 用法: node cdp_download.js <cdp-url> <file-url> <save-dir>
const http = require("http");

const [, , cdpUrl, fileUrl, saveDir] = process.argv;
if (!cdpUrl || !fileUrl || !saveDir) {
  console.error("usage: node cdp_download.js <cdp-url> <file-url> <save-dir>");
  process.exit(1);
}

function rpc(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve(JSON.parse(d)));
    }).on("error", reject);
  });
}

(async () => {
  const ws = new WebSocket(cdpUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
    });

  const events = [];
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    } else if (msg.method) {
      events.push(msg);
      if (msg.method === "Browser.downloadProgress") {
        const p = msg.params;
        if (p.state === "inProgress" && p.receivedBytes % (50 * 1024 * 1024) < 3e6) {
          console.log(`progress: ${(p.receivedBytes / 1048576).toFixed(0)}MB / ${((p.totalBytes || 0) / 1048576).toFixed(0)}MB`);
        }
        if (p.state === "completed") console.log("COMPLETED:", p.guid);
        if (p.state === "canceled") console.log("CANCELED:", p.guid);
      }
    }
  };

  await new Promise((r) => (ws.onopen = r));

  // 允许下载并指定目录（浏览器级）
  await send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: saveDir,
    eventsEnabled: true,
  });

  // 新建页面并直接导航到文件 URL
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  console.log("navigating:", fileUrl);
  await send("Page.navigate", { url: fileUrl }, sessionId);

  // 等待下载完成（最长 15 分钟）
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    const done = events.find(
      (m) => m.method === "Browser.downloadProgress" &&
        (m.params.state === "completed" || m.params.state === "canceled")
    );
    if (done) {
      console.log("final state:", done.params.state);
      process.exit(done.params.state === "completed" ? 0 : 2);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log("TIMEOUT");
  process.exit(3);
})().catch((e) => {
  console.error("ERR:", e.message);
  process.exit(1);
});
