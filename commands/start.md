---
description: Start a Figma → Divi build — one short form (IR export, Figma link + token, font files, target OS), then the whole pipeline runs by itself (build, draft deploy, checks, agent QA, report)
argument-hint: "[path to figma-ir zip or folder]"
---

Start a figma2divi build. **Collect every answer first, then do all the work in one go** — no
processing between questions, no confirmations in between.

`F2D` = `node "${CLAUDE_PLUGIN_ROOT}/bin/f2d.mjs"`, always run from the project directory (section 3).

## 1. One form (a single AskUserQuestion call with all four questions)

Before showing it, quietly list candidate IR exports (zips or folders whose name contains `ir`, or
that contain `ir.json`) in the user's Downloads folder and the current directory, newest first. Do
nothing else before the form.

Ask these four questions **in one AskUserQuestion call**:

1. **"Which Figma IR export should I build?"** (header "IR export") — up to 3 found exports as options
   (label = file name, description = folder + date). The user types any other path via "Other".
   If `$ARGUMENTS` already holds a path, leave this question out.
2. **"Do you have the Figma design link and an access token?"** (header "Figma") — options:
   - "Link + token" — description: "I'll paste both. The token lets the pipeline fetch image fills the export is missing."
   - "Link only" — description: "I'll paste the link; no token."
   - "Neither" — description: "Build from the export alone; anything missing is reported, never guessed."
3. **"Do you have the design's font files?"** (header "Fonts") — options:
   - "No — pick the best match" (first, recommended) — description: "The design's own font from Google Fonts when it exists there; otherwise the closest measured stand-in, recorded in the report."
   - "Yes — I'll paste the folder path" — description: "A folder with .woff2 / .woff / .ttf / .otf files; they are uploaded and served under the design's font name."
4. **"Which OS do this site's visitors mostly use?"** (header "Target OS") — "Windows" (classic
   scrollbars take ~15–17px of layout width), "macOS" (overlay scrollbars), "Both".

## 2. One follow-up message, only if something must be pasted

If the answers need pasted values (a link, a token, a font folder), ask for **all of them in one
message**, e.g. "Paste these in one message, one per line: 1) Figma link 2) Figma access token
3) font folder path". If nothing needs pasting, skip this step.

Validate everything before starting: the export exists and is a figma-ir/1 zip or folder (has
`ir.json`); the link is a `figma.com/design/…` or `figma.com/file/…` URL; the font folder exists and
holds font files. If something is wrong, say exactly what and ask for just that item again.

**The token is a secret:** never print, echo, log or repeat it, never put it in a command line you show,
a report or any file other than `<project>/.env-local/figma.env`.

## 3. Then run everything, without stopping

Say once: "Got everything — starting the pipeline." Then, telling the user in one short line when each
stage starts:

1. **Project:** the current directory if it has `f2d.config.json`; else a `f2d-project` folder next to
   the WordPress site the config / user context points at; else the current directory. **Page slug** from
   the export's name (`homepage-ir.zip` → `homepage`), lowercase, dashes; if that slug exists with a
   different input, add `-2`, `-3`. **Site:** keep `site.url` / `site.wp` from an existing config — only
   when there is none, ask for the local WordPress URL (the one allowed extra question; it must be a
   local / dev / staging site with Divi and the `f2d-bridge` plugin).
2. `F2D init --os <windows|macos|both> --page <slug> --input "<export path>"` (+ `--site <url>` when new).
3. **Figma:** link → `F2D figma link "<url>"`. Token → write `FIGMA_TOKEN=<token>` to
   `<project>/.env-local/figma.env` (create the folder) with the Write tool and
   `F2D config set figma.envFile ".env-local/figma.env"`.
4. `F2D doctor` — every check OK. Site not running → ask the user to start it (e.g. in Local) and wait.
   Bridge missing or older than `${CLAUDE_PLUGIN_ROOT}/wp-plugin/f2d-bridge` → copy it into the site's
   `wp-content/plugins/` and activate it.
5. `F2D analyze <slug>`, then **fonts** (`F2D fonts list <slug>` shows each family and its status):
   - **Folder given:** `F2D fonts add <slug> --dir "<folder>"` (matches files to the design's families
     by name; with a single family use `--family "<name>"`). Any family without files falls through to
     the next rule.
   - **No files** (or a family the folder lacks): for each family not already `web-font` / `font-files` /
     a Helvetica/Arial system stack: `F2D fonts web <slug> --family "<name>"` — the design's own font
     from Google Fonts. If Google doesn't have it: `F2D fonts probe <slug> --family "<name>"` (measures
     candidates against the Figma screenshot), pick the best-scoring stand-in that suits the site's
     style, and `F2D fonts web <slug> --family "<name>" --use "<stand-in>" --reason "<why: measured
     score, style>"`. Mention each substitute in the final summary.
6. `F2D run <slug>` — plan, compile, deploy a **draft**, functional checks (stops at
   `awaiting-agent-qa`).
7. Launch the **f2d-qa** agent (slug + project directory): it judges every section against Figma,
   repairs, rebuilds, redeploys, verifies, locks, and writes `qa/agent/verdict.json`.
8. `F2D run <slug> --resume` — functional checks on the final build and the report.

## 4. Finish

Relay from `pages/<slug>/reports/final-report.md`: the verdict, the per-section table, open issues,
functional failures, fonts used (real / uploaded / substituted and why), the agent's questions, and the
draft's edit link. Never publish; drafts only.
