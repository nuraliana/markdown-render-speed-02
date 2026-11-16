# markdown-render-speed-02

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/nuraliana/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/nuraliana/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A fast, dependency-free drop-in for marked 18.1.3. `parse.js` renders exactly the HTML marked renders with its default options (GFM on, breaks off, pedantic off) — every CommonMark 0.31.2 spec example and every GFM 0.29 extension example, code unit for code unit — for less CPU. It is a from-scratch implementation of marked's parsing rules: a block lexer, an inline lexer with CommonMark emphasis resolution, and a renderer, with no vendored marked code and no dependencies. `main.ts` is the program the harness runs: it reads every case from `/input/cases.json`, renders each one alone with `parse`, and writes the HTML strings in order to `/output/html.json`.

## Run it

```sh
MAKEFUN_INPUT_DIR=./input MAKEFUN_OUTPUT_DIR=./output node main.ts
```

Without the environment variables, `main.ts` reads `/input/cases.json` and writes `/output/html.json`, as the harness provides them. To grade locally against the practice set, run from the unpacked kit:

```sh
node cli/makefun.mjs grade-local --kit . --bot <this repository> --worktree --driver process
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=ctnjhg8e&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
