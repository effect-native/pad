const serverConfig = globalThis.__PAD_SERVER__;

const html = String.raw;

function byId(id) {
  return document.getElementById(id);
}

function setText(node, text) {
  if (node) node.textContent = text;
}

function stripShebang(source) {
  return source.startsWith("#!") ? source.replace(/^#!.*\n/, "") : source;
}

function escapeHtml(source) {
  return source.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[char] || char);
}

function markdownPreview(source) {
  const body = stripShebang(source)
    .replace(/^<!-- PAD:[\s\S]*?-->\s*/i, "")
    .trim();
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{font:16px/1.55 ui-sans-serif,system-ui;padding:2rem;max-width:48rem;margin:auto}pre{white-space:pre-wrap}</style><pre>${escapeHtml(body)}</pre>`;
}

function previewSource(source, kind) {
  if (kind === "html" || kind === "svg") return stripShebang(source);
  if (kind === "md") return markdownPreview(source);
  return `<!doctype html><meta charset="utf-8"><pre>${escapeHtml(stripShebang(source))}</pre>`;
}

function downloadSource(source, fileName) {
  const blob = new Blob([source], { type: "text/plain;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = fileName || "document.pad.html";
  document.body.append(link);
  link.click();
  window.setTimeout(() => {
    URL.revokeObjectURL(link.href);
    link.remove();
  }, 1000);
}

function acceptTypes(fileName) {
  const lower = (fileName || "").toLowerCase();
  if (lower.endsWith(".svg")) return [{ description: "SVG PAD", accept: { "image/svg+xml": [".svg"] } }];
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return [{ description: "Markdown PAD", accept: { "text/markdown": [".md", ".markdown"], "text/plain": [".md"] } }];
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return [{ description: "HTML PAD", accept: { "text/html": [".html", ".htm"] } }];
  return [{ description: "PAD file", accept: { "text/plain": [".txt", ".md", ".html", ".svg"] } }];
}

async function pickWritableFile(fileName) {
  if (!globalThis.showOpenFilePicker) throw new Error("This browser does not expose showOpenFilePicker. Use Chrome or Edge for in-place browser saves.");
  const [handle] = await globalThis.showOpenFilePicker({ multiple: false, types: acceptTypes(fileName) });
  const permission = await handle.requestPermission({ mode: "readwrite" });
  if (permission !== "granted") throw new Error(`Read/write permission was ${permission}.`);
  return handle;
}

async function writeHandle(handle, source) {
  const writable = await handle.createWritable();
  await writable.write(source);
  await writable.close();
}

function startServerEditor(config) {
  const sourceInput = byId("padSource");
  const preview = byId("padPreview");
  const status = byId("padStatus");
  const saveServer = byId("padSaveServer");
  const download = byId("padDownload");
  const pickFile = byId("padPickFile");
  const savePicked = byId("padSavePicked");
  const copyUrl = byId("padCopyUrl");
  let socket = null;
  let reconnectTimer = null;
  let sendTimer = null;
  let fileHandle = null;
  let currentSource = "";
  let dirty = false;
  let reconnectAttempts = 0;

  function setStatus(text) {
    setText(status, text);
  }

  function render(source = currentSource) {
    if (preview) preview.srcdoc = previewSource(source, config.kind);
  }

  function send(message) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  function queueUpdate(reason) {
    window.clearTimeout(sendTimer);
    sendTimer = window.setTimeout(() => {
      send({ type: "update", source: currentSource, reason });
    }, 120);
  }

  function connect() {
    window.clearTimeout(reconnectTimer);
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(`${protocol}//${location.host}/ws${location.search}`);
    setStatus("Connecting to trusted Bun server...");

    socket.addEventListener("open", () => {
      reconnectAttempts = 0;
      setStatus("Connected. Edits sync over WebSocket; Save writes the original file.");
    });

    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }

      if (message.type === "hello") {
        currentSource = String(message.source || "");
        sourceInput.value = currentSource;
        render();
        if (message.savedAt) setStatus(`Connected. Last saved ${new Date(message.savedAt).toLocaleTimeString()}.`);
        return;
      }

      if (message.type === "source" && document.activeElement !== sourceInput) {
        currentSource = String(message.source || "");
        sourceInput.value = currentSource;
        render();
        dirty = true;
        setStatus(`Applied edit from another client: ${message.reason || "client edit"}.`);
        return;
      }

      if (message.type === "saved") {
        currentSource = String(message.source || currentSource);
        dirty = false;
        setStatus(`Saved to original file at ${new Date(message.savedAt).toLocaleTimeString()}.`);
        return;
      }

      if (message.type === "peer-count") {
        document.documentElement.dataset.padPeers = String(message.count || 0);
        return;
      }

      if (message.type === "server-error") setStatus(`Server error: ${message.message}`);
    });

    socket.addEventListener("close", () => {
      reconnectAttempts += 1;
      if (reconnectAttempts > 8) {
        setStatus("Disconnected. The trusted Bun server appears to be stopped.");
        return;
      }
      setStatus("Disconnected. Reconnecting while the server is still alive...");
      reconnectTimer = window.setTimeout(connect, 700);
    });
  }

  sourceInput.addEventListener("input", () => {
    currentSource = sourceInput.value;
    dirty = true;
    render();
    queueUpdate("source edit");
    setStatus("Unsaved edit. Save to write the original file, or download a copy.");
  });

  saveServer.addEventListener("click", () => {
    if (send({ type: "save", source: currentSource, reason: "server save button" })) setStatus("Saving to original file...");
  });

  download.addEventListener("click", () => downloadSource(currentSource, config.fileName));

  pickFile.addEventListener("click", async () => {
    try {
      fileHandle = await pickWritableFile(config.fileName);
      savePicked.disabled = false;
      setStatus("Chrome file permission granted. You can save this source through the browser too.");
    } catch (error) {
      setStatus(error.message || String(error));
    }
  });

  savePicked.addEventListener("click", async () => {
    try {
      await writeHandle(fileHandle, currentSource);
      setStatus("Saved through the browser file handle.");
    } catch (error) {
      setStatus(`Browser save failed: ${error.message || error}`);
    }
  });

  copyUrl.addEventListener("click", async () => {
    await navigator.clipboard.writeText(config.publicUrl || location.href);
    setStatus("Copied the phone/iPad URL.");
  });

  window.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      saveServer.click();
    }
  });

  window.addEventListener("beforeunload", (event) => {
    if (!dirty) return;
    event.preventDefault();
    event.returnValue = "";
  });

  connect();
}

function serializeStaticDocument(prefix = "") {
  const clone = document.documentElement.cloneNode(true);
  clone.querySelectorAll("[data-pad-browser]").forEach((node) => node.remove());
  clone.querySelectorAll("[contenteditable]").forEach((node) => node.removeAttribute("contenteditable"));
  clone.querySelectorAll("[spellcheck]").forEach((node) => node.removeAttribute("spellcheck"));
  const body = clone.querySelector("body");
  while (body && body.firstChild) {
    const node = body.firstChild;
    if (node.nodeType === Node.TEXT_NODE && node.textContent.trim().startsWith("#!")) {
      node.remove();
      continue;
    }
    if (node.nodeType === Node.COMMENT_NODE && /^\s*PAD:/i.test(node.textContent || "")) {
      node.remove();
      continue;
    }
    break;
  }
  return `${prefix}<!doctype html>\n${clone.outerHTML}\n`;
}

function loadedPadPrefix() {
  const body = document.body;
  let prefix = "";
  if (!body) return prefix;

  for (const node of body.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent || "";
      if (/^\s*$/.test(text)) continue;
      const shebang = /^\s*(#!.*)(?:\n|$)/.exec(text);
      if (!shebang) break;
      prefix += `${shebang[1]}\n`;
      continue;
    }

    if (node.nodeType === Node.COMMENT_NODE && /^\s*PAD:/i.test(node.textContent || "")) {
      prefix += `<!--${node.textContent}-->\n`;
      continue;
    }

    break;
  }

  return prefix;
}

function startStaticEnhancer() {
  const main = document.querySelector("main") || document.body.appendChild(document.createElement("main"));
  const card = document.createElement("section");
  let fileHandle = null;
  let shebangPrefix = loadedPadPrefix();
  let saveTimer = null;
  const fileName = decodeURIComponent(location.pathname.split("/").pop() || "document.pad.html");
  document.documentElement.dataset.pad = "browser";
  card.dataset.padBrowser = "";
  card.contentEditable = "false";
  card.innerHTML = html`
    <strong>Browser mode</strong>
    <p>Enable page editing, then download a changed copy or use Chrome/Edge file permission to save in place.</p>
    <div class="pad-browser-actions">
      <button type="button" data-pad-enable>Edit page</button>
      <button type="button" data-pad-pick>Pick this file</button>
      <button type="button" data-pad-save disabled>Save picked file</button>
      <button type="button" data-pad-download>Download copy</button>
    </div>
    <p data-pad-status>Static browser mode. Running the PAD starts the trusted Bun server.</p>
  `;
  main.append(card);

  const status = card.querySelector("[data-pad-status]");
  const enable = card.querySelector("[data-pad-enable]");
  const pick = card.querySelector("[data-pad-pick]");
  const save = card.querySelector("[data-pad-save]");
  const download = card.querySelector("[data-pad-download]");

  function setStatus(text) {
    setText(status, text);
  }

  function currentSource() {
    return serializeStaticDocument(shebangPrefix);
  }

  function scheduleSave() {
    if (!fileHandle || document.body.contentEditable !== "true") return;
    window.clearTimeout(saveTimer);
    setStatus("Change detected. Browser save scheduled.");
    saveTimer = window.setTimeout(async () => {
      try {
        await writeHandle(fileHandle, currentSource());
        setStatus("Saved in place through Chrome/Edge file permission.");
      } catch (error) {
        setStatus(`Autosave failed: ${error.message || error}`);
      }
    }, 1200);
  }

  enable.addEventListener("click", () => {
    document.body.contentEditable = "true";
    document.body.spellcheck = false;
    card.contentEditable = "false";
    enable.disabled = true;
    setStatus(fileHandle ? "Editing enabled. Changes autosave through the picked file handle." : "Editing enabled. Pick the file for in-place save, or download a copy.");
  });

  pick.addEventListener("click", async () => {
    try {
      fileHandle = await pickWritableFile(fileName);
      const file = await fileHandle.getFile();
      const source = await file.text();
      const prefixMatch = /^(#!.*\n(?:<!-- PAD:[\s\S]*?-->\s*)?)/.exec(source);
      shebangPrefix = prefixMatch ? prefixMatch[1] : "";
      save.disabled = false;
      setStatus(`Permission granted for ${file.name}. In-place saves will preserve the PAD shebang prefix if present.`);
    } catch (error) {
      setStatus(error.message || String(error));
    }
  });

  save.addEventListener("click", async () => {
    try {
      await writeHandle(fileHandle, currentSource());
      setStatus("Saved in place through Chrome/Edge file permission.");
    } catch (error) {
      setStatus(`Save failed: ${error.message || error}`);
    }
  });

  download.addEventListener("click", () => {
    downloadSource(currentSource(), fileName);
    setStatus("Downloaded an edited copy.");
  });

  document.addEventListener("input", scheduleSave);
}

if (serverConfig && serverConfig.mode === "server") startServerEditor(serverConfig);
else startStaticEnhancer();
