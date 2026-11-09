# Skills to download

These are the reusable Claude Code skills used to build Cinewall. Skills written only for that app (subtitles, the video player, the poster wall and so on) are left out.

Claude: install these skills with the commands below, using each command as written. Ask which groups are wanted if the project clearly doesn't need them all. The last two groups only apply to projects using those tools.

Add `-g` to any command to install for all projects instead of just the current one.

## Planning and building

| Skill | What it does |
|---|---|
| `brainstorming` | Works out the design with you before anything gets built |
| `writing-plans` | Turns a design into a step-by-step plan |
| `executing-plans` | Carries out a plan in the current session |
| `subagent-driven-development` | Carries out a plan's separate tasks using subagents |
| `test-driven-development` | Writes a failing test before the code |
| `systematic-debugging` | Finds the root cause before attempting a fix |
| `verification-before-completion` | Requires proof before claiming work is done |
| `requesting-code-review` | Gets the work reviewed before merging |

```
npx skills add obra/superpowers --skill brainstorming writing-plans executing-plans subagent-driven-development test-driven-development systematic-debugging verification-before-completion requesting-code-review
```

## Code structure

| Skill | What it does |
|---|---|
| `improve-codebase-architecture` | Finds ways to improve a codebase's structure |

```
npx skills add mattpocock/skills --skill improve-codebase-architecture
```

## Visual design

| Skill | What it does |
|---|---|
| `frontend-design` | Distinctive visual design that doesn't look templated |
| `design-taste-frontend` | Art direction, palette and type |
| `impeccable` | Designs, critiques and polishes interfaces |
| `web-design-guidelines` | Reviews UI code against web interface guidelines |

```
npx skills add anthropics/skills --skill frontend-design
npx skills add leonxlnx/taste-skill --skill design-taste-frontend
npx skills add pbakaus/impeccable --skill impeccable
npx skills add vercel-labs/agent-skills --skill web-design-guidelines
```

## Motion and interaction

| Skill | What it does |
|---|---|
| `apple-design` | Apple-style interface design and fluid, physical motion |
| `emil-design-eng` | UI polish and the small details that make software feel great |
| `improve-animations` | Audits a codebase's animations and plans improvements |
| `review-animations` | Reviews animation code against a high bar |
| `animation-performance` | Keeps animations smooth and finds dropped frames |
| `framer-motion` | Animation principles using Framer Motion in React |

```
npx skills add emilkowalski/skills --skill apple-design emil-design-eng improve-animations review-animations animation-performance
npx skills add calesthio/openmontage --skill framer-motion
```

## Web quality

| Skill | What it does |
|---|---|
| `accessibility` | Audits and improves accessibility (WCAG 2.2) |
| `performance` | Makes pages load and run faster |

```
npx skills add addyosmani/web-quality-skills --skill accessibility performance
```

## React, Vite and testing (only if the project uses them)

| Skill | What it does |
|---|---|
| `vercel-react-best-practices` | React and Next.js performance guidelines |
| `vercel-composition-patterns` | React component patterns that scale |
| `vite` | Vite configuration and plugins |
| `vitest` | Unit testing with Vitest |
| `playwright-best-practices` | Reliable end-to-end tests with Playwright |

```
npx skills add vercel-labs/agent-skills --skill vercel-react-best-practices vercel-composition-patterns
npx skills add antfu/skills --skill vite vitest
npx skills add currents-dev/playwright-best-practices-skill --skill playwright-best-practices
```

## Electron desktop apps (only if the project uses Electron)

| Skill | What it does |
|---|---|
| `electron` | General patterns for Electron apps |
| `electron-skills` | Type-safe communication between Electron's main and renderer processes |

```
npx skills add gentleman-programming/gentleman-skills --skill electron
npx skills add mym0404/agent-skills --skill electron-skills
```
