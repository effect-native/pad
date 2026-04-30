# PAD

Portable App Documents.

Preview like a file. Open like a page. Run like an app.

A PAD is a normal Markdown, HTML, or SVG file that you can preview as a document, open in a browser, and optionally run as a local program when you explicitly trust it.

## Create

Try this first. It runs the beta generator and creates a PAD file in the current directory. Preview the created file before you run the PAD itself.

```sh
bun ./note.tsx some random thing
```

Creates:

```text
YYYY-MM-DD-some-random-thing.pad.md
```

Create other previewable web-native forms:

```sh
bun ./note.tsx --html checklist
bun ./note.tsx --svg diagram
```

## Run

PAD files can include a shebang:

```sh
#!/usr/bin/env -S bun ./note.tsx --pad
```

When executed, the document path is passed to `bun ./note.tsx --pad` and enters trusted program mode. Running a PAD crosses the boundary from "view this document" to "execute local code with Bun". Only run PADs you would trust as scripts.

## Trust Ladder

- Preview in Finder, Quick Look, or another static viewer: document only, no JavaScript.
- Open in a browser: web code may run, subject to browser permissions.
- Run in a shell: trusted local program mode; treat it like executing a script.

Executable HTML PADs deliberately put the shebang before `<!doctype html>`. That tradeoff is the point: the same file can be previewed, opened, and run. Browsers tolerate the line as document text; PAD CSS/browser affordances can make that cost acceptable for documents that choose executable mode.

HTML PADs may also load browser assets from a CDN, as the example does with jsDelivr. That is a browser trust boundary, separate from shell execution.

Generated executable PADs include an SGML-style comment after the shebang to make that tradeoff explicit in source.

```sh
./checklist.pad.html
```

Trusted run mode starts a Bun editor server on `0.0.0.0` with an open port. It prints a local URL, a tokenized `http://$(hostname).local:PORT` phone/iPad URL, and a QR code you can scan. Browser clients sync edits over WebSocket; the server shuts down shortly after the last browser client disconnects.

The served editor can save back to the original file. The browser asset `pad.mjs` also offers static browser editing affordances: download a changed copy anywhere, or in Chrome/Edge pick the file and save in place with the File System Access API.

## Why

A PAD is a document that can become software when you trust it.

- Finder/Quick Look can preview current state without JavaScript.
- Browsers can run sandboxed JavaScript modules.
- Chrome can request file permissions with `window.showOpenFilePicker` for safe self-save flows.
- The shell can run the same file as a trusted Bun program.
- Copying the file is branching. The filesystem is auth. No account or hosted database required.

PAD is not a new file format. It is a convention over existing web and Unix standards.
