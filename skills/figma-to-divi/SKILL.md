---
name: figma-to-divi
description: Build, QA and repair a Divi 4 page from a Figma design (figma-ir/1 export zip/folder, optionally a Figma URL + token) with the f2d pipeline — Planner first, then compile, deploy as a draft, objective functional checks, and agent-judged QA section by section (DEV Connect model) ending in a verdict and report. Use when the user hands over a Figma IR export or asks to build, rebuild, QA, repair, report on or roll back a figma2divi page.
---

# Figma → Divi with f2d

The CLI does every measurable step and prints JSON. You orchestrate, run the planner and QA agents where judgement is needed, and report only what the CLI measured.

`F2D` below means: `node "${CLAUDE_PLUGIN_ROOT}/bin/f2d.mjs"`, run from the project directory (the folder holding `f2d.config.json`).

## 0. Before anything else for a new site

1. **Ask the user which OS the site targets: Windows, macOS or both.** Never assume. Windows classic scrollbars take layout width (a 1920px window leaves ~1905px); macOS overlay scrollbars do not. QA renders under that scrollbar mode.
2. Make sure the target is a **local / development / staging** WordPress with the Divi Builder plugin (4.2x) active. Never point it at production.
3. `F2D init --os <windows|macos|both> --site <url> --page <slug> --input <path to figma-ir zip or folder>` then fill `site.wp` (php, ini, phar, path) in `f2d.config.json`.
4. Copy `${CLAUDE_PLUGIN_ROOT}/wp-plugin/f2d-bridge` into the site's `wp-content/plugins/` and activate it (`wp plugin activate f2d-bridge`).
5. `F2D doctor` — every check must be OK before building.

Secrets (Figma token, application passwords) go in an env file referenced by `figma.envFile`, never in the config, prompts or reports.

## 1. Analyze and plan (mandatory before compiling)

```
F2D analyze <slug>
F2D plan <slug>
```

Then launch the **f2d-planner** agent with the slug and project directory. It reviews `build-plan.json`, resolves what it can, and records amendments with `F2D plan amend`. Ask the user only about things that block execution (e.g. missing font files). Missing fonts: run `F2D fonts probe <slug>`; record a measured substitute in config only as an interim, and say so.

`F2D plan validate <slug>` must return `ok: true`.

## 2. Build, then agent-judged QA (the DEV Connect model)

```
F2D run <slug>
```

The run analyzes, plans, builds, deploys a **draft** and runs the objective functional checks (render, console errors, assets, sections and text, links, forms, menu / accordion / slider / ticker, sticky header, drawer, overflow at every width, and the Divi Visual Builder matching the front end in its desktop / tablet / phone views). It stops with `status: awaiting-agent-qa`. Then:

1. Launch **f2d-qa** (slug, project dir). It judges the page itself, one section at a time, top to bottom (header + drawer first), in one continuous session: `F2D shot --section N` (built vs Figma crop: diff, side-by-side, similarity as evidence), `F2D measure` (built vs IR numbers), diagnosis, IR repairs (`F2D repair --apply`), `F2D build` + `F2D deploy`, recapture, verify — then `F2D sweep --section N` (contact sheets at every width 3840 → 320 and every rotated view) for the responsive pass, fixes on the ladder tier covering each break, and locks the section in `qa/agent/section-qa-state.json`. It ends with a whole-page pass and `qa/agent/verdict.json` (PASS / FAIL / BLOCKED).
2. `F2D run <slug> --resume` — re-runs the functional checks on the final deployed build, validates the section state against the evidence on disk, and writes the report.

No script score decides the result: the verdict is the agent's, made by looking at the evidence; the functional checks are objective and block a PASS while one fails. The compiler stays deterministic — the agent changes the page only through repairs, and reports systemic causes as `compiler_findings`.

Responsive rules (applied by the compiler, judged by the agent) are the DEV Connect ones with Divi's edges: the ladder widescreen (4K containment) / desktop / laptop ≤1366 / tablet-extra ≤1200 / tablet ≤980 / mobile-extra ≤880 / phone ≤767, fixes on the tier covering the break, stepped type (no clamp/vw), rows stacking text-first from 880, two-up grids by 1200, an always-sticky header with a slim compact bar and drawer, 44×44 tap targets, hover/focus on every button.

## 3. Report

`F2D report <slug>` writes `pages/<slug>/reports/final-report.md` from the agent's verdict and section state plus the functional checks. Relay: the verdict, the per-section table (status, similarity as evidence, responsive result, open issues), functional failures, deliberate deviations, compiler findings, limitations and the questions for the user. Never claim a result that is not in the report.

## Other commands

- `F2D check <slug>` — the functional checks on the deployed build (also run by `run`).
- `F2D shot | measure | sweep <slug> --section N` — the agent's evidence instruments; useful by hand too.
- `F2D qa <slug> --quick` — legacy scripted metrics (diagnostic only, never a verdict).
- `F2D rollback <slug> --build <id>` — redeploy any previous build.
- `F2D calibrate` — re-validate the visual metric (writes docs/SCORING.md).
- Publishing is blocked unless `site.allowPublish` is true **and** the user explicitly approved it.
