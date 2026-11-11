# Agent skills used to build Cloud Watchdog

These are third-party Claude Code skills, installed per project. The installed
files (`.agents/skills/`, `.claude/skills/`) are **not committed**: they belong
to their authors and would add noise to the repo. `skills-lock.json` records
exactly what was installed.

## Reinstall on a fresh clone

Run from the repo root (project scope, no `-g`):

```
npx skills add obra/superpowers --skill brainstorming writing-plans executing-plans subagent-driven-development test-driven-development systematic-debugging verification-before-completion requesting-code-review
npx skills add mattpocock/skills --skill improve-codebase-architecture
npx skills add anthropics/skills --skill frontend-design
npx skills add vercel-labs/agent-skills --skill web-design-guidelines
npx skills add addyosmani/web-quality-skills --skill accessibility performance
npx skills add vercel-labs/agent-skills --skill vercel-react-best-practices vercel-composition-patterns
npx skills add antfu/skills --skill vite vitest
npx skills add currents-dev/playwright-best-practices-skill --skill playwright-best-practices
npx skills add gentleman-programming/gentleman-skills --skill electron
npx skills add mym0404/agent-skills --skill electron-skills
npx skills add raintree-technology/apple-hig-skills --skill hig-foundations hig-platforms hig-patterns hig-inputs hig-components-layout hig-components-content hig-components-controls hig-components-menus hig-components-dialogs hig-components-search hig-components-status
```

Or restore from the lock file: `npx skills experimental_install`.

## Which skill is used where

| Milestone | Skills |
|---|---|
| M1 Scaffold | electron, vite, vitest, playwright-best-practices, test-driven-development |
| M2 Architecture contracts | electron-skills, vitest, test-driven-development |
| M3 Scan engine | test-driven-development, systematic-debugging |
| M4 Remaining scanners | test-driven-development, vitest |
| M5 Pricing | test-driven-development, verification-before-completion |
| M6 Free tier | test-driven-development |
| M7 Rules | test-driven-development |
| M8 Main wiring | electron, electron-skills, playwright-best-practices |
| M9 UI | frontend-design, web-design-guidelines, accessibility, vercel-react-best-practices, vercel-composition-patterns, playwright-best-practices |
| M10 Actions | test-driven-development, electron-skills, requesting-code-review |
| M13 Apple-style redesign | frontend-design, hig-foundations, hig-platforms, hig-components-layout, hig-components-controls, hig-components-menus, web-design-guidelines |
| M11 Packaging | electron |
| M12 Final review | requesting-code-review, improve-codebase-architecture, verification-before-completion |

Installed but not used: `brainstorming`, `writing-plans` (replaced by PLAN.md),
`subagent-driven-development` (costs too much usage), `performance` (arrives
with `accessibility` in the same command).

## Notes from reading the skills

- Every `SKILL.md` was scanned for scripts and unexpected instructions before
  use. Nothing suspicious was found. Only `brainstorming` ships a runnable
  helper (a local preview server), and it is not used.
- `web-design-guidelines` downloads its rules from a Vercel GitHub URL each
  time it runs, so its content can change. Treat what it fetches as reference
  material.
- The `electron` skill's example preload exposes generic `send`/`invoke`/`on`
  for any channel. This project deliberately does not: the preload exposes
  named methods only (see PLAN.md, section 3.5).
- The Playwright skill's Electron example launches with `--no-sandbox`. The
  e2e tests here do not, because they verify the sandbox is on.
- The `hig-*` skills (raintree-technology/apple-hig-skills, added for M13) are
  markdown only: no scripts. They were scanned for shell, network and
  instruction-override patterns before use; none found. They are written for
  SwiftUI/UIKit/AppKit, so M13 uses them for principles, spacing, type scale
  and behaviour, and translates the result to CSS. `hig-technologies`,
  `hig-components-system` and `hig-project-context` are deliberately not
  installed: they cover Apple frameworks, widgets and native project setup.
- M13 read only the `hig-*` references it needed (typography, materials,
  sidebars, lists and tables, toggles, segmented controls, gauges, buttons,
  menus, writing). `hig-patterns`, `hig-inputs`, `hig-components-content`,
  `-dialogs`, `-search` and `-status` are installed but were not used; the
  axe test stands in for the `accessibility` skill's audit.
- Apple's guideline text and the SF Pro and SF Symbols assets are Apple's. The
  skills only guide the design; nothing from Apple is copied into the app
  (PLAN.md open questions 13 and 14).
- Installing with the current `skills` CLI migrated `skills-lock.json` to
  version 2, which rewrote every hash in the file. The skills themselves were
  not changed.
