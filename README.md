# PAD

Portable App Documents.

Preview like a file. Open like a page. Run like an app.

## Create

```sh
bunx note some random thing
```

Creates:

```text
YYYY-MM-DD-some-random-thing.pad.md
```

Create other previewable web-native forms:

```sh
bunx note --html checklist
bunx note --svg diagram
```

## Run

PAD files can include a shebang:

```sh
#!/usr/bin/env -S bunx --bun note --pad
```

When executed, the document path is passed to `note --pad` and enters trusted program mode.

## Why

A PAD is a document that can become software when you trust it.

- Finder/Quick Look can preview current state without JavaScript.
- Browsers can run sandboxed JavaScript modules.
- Chrome can request file permissions with `window.showOpenFilePicker` for safe self-save flows.
- The shell can run the same file as a trusted Bun program.
- Copying the file is branching. The filesystem is auth. No account or hosted database required.

PAD is not a new file format. It is a convention over existing web and Unix standards.
