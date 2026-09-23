# Working agreement for this repository

## Every round ends with a commit and a push

Land the round's work on `main` before reporting it done. A round that lives
only in the working tree is a round the next session cannot see, cannot build
on, and cannot tell apart from an experiment someone abandoned.

The order is: verify, commit, push. Do not push a tree whose tests have not
just passed — the suite is the only evidence that the tree is the one that
passed.

```
npm test              # 541 tests, all green before anything is pushed
npm run check:extension
git add -A
git commit
git push origin main
```

If the push is rejected because the remote moved, do not force it blindly.
Fetch, read what arrived, and decide. See below.

## Two lines of work have already collided once

`HANDOVER.md` records this in full; the short version is what to do differently
next time.

Two lines of work grew from the same commit and both numbered their rounds
`v35`, `v36`, … — so a version number alone does not identify a piece of work.
When a push is rejected, the question is not "how do I get my commits up" but
"what is on the remote, and whose is it".

Preserve before you overwrite. A branch costs nothing and cannot be undone:

```
git fetch origin
git log --oneline HEAD..origin/main     # what arrived
git push origin <sha>:refs/heads/<name> # park it before touching main
```

Then use `--force-with-lease=<ref>:<expected-sha>` rather than `--force`. The
lease refuses to overwrite anything that moved since you looked; `--force`
overwrites whatever is there, including work you never read.

## 中文说明

- **每轮结束要把工作提交并推送到 `main`**，顺序是"先验证、再提交、再推送"。
  只留在工作区的一轮工作，下一次会话看不见、接不上，也分不清它是不是被放弃的实验。
- **推送被拒时不要盲目强推。** 先 `git fetch` 看清远程多了什么、是谁的，
  用分支把对方的工作原样存下来，再用 `--force-with-lease=<ref>:<期望 sha>`
  而不是 `--force`——前者会拒绝覆盖你查看之后又变动过的内容，后者不会。
- 版本号（v35、v36…）**不足以唯一标识一份工作**，这个仓库曾经同时存在两条
  各自编号的版本线；要引用某一轮，连它的分支或提交一起说。

## Testing on this machine

- `node --test` is **unusable here**: it forks a process per file and the
  sandbox refuses the pipes, so files fail with `spawn EPERM`. The suite is this
  project's own single-process runner (`packages/dsh-browser-bridge/test/run.js`).
  Do not introduce `node:test`.
- The suite is **zero-dependency by design**. A fresh clone runs `npm test` with
  no install step; the host's peer dependencies resolve only inside a real `dsh`
  process.
- The four real-browser e2e tests need a Playwright Chromium or Chrome for
  Testing on the machine. Without one they **skip and say so** rather than fail.
- **Run the suite on a quiet machine.** Leftover headless browsers and stray
  `node` processes from earlier runs make the real-browser tests flaky — a run
  under that pressure reports a failure that a clean run does not. Confirm a red
  run with a second, clean one before treating it as a real defect.

## Line endings: the working tree is LF, and PowerShell lies about it

`.gitattributes` sets `* text=auto eol=lf`, so **LF on disk is correct** and the
committed blobs are LF.

`git show HEAD:file | Out-File ...` reports CRLF on this machine with
`core.autocrlf=true`, because the pipe re-encodes on the way out. Concluding from
that reading that a file "lost CRLF" is a **measurement artifact**, not a
finding — it nearly cost a round to a script that would have rewritten the whole
tree to CRLF.

To judge whether a diff is real, let git answer:

```
git diff --numstat -- <file>   # insertions/deletions, not a whole-file rewrite
```

A genuine focused change reads as `95  1`; a line-ending rewrite reads as
thousands of lines both ways.

## Screenshots are claims, and claims rot

`docs/screenshots/` is rendered from the panel, so it goes stale whenever the
stylesheet moves. That happened: a commit changed the answer's reading measure
and did not regenerate the gallery, three more commits moved panel styles, and
`picture.png` spent four commits showing a layout the product no longer had —
661756 differing pixels of 1094400 — while every test stayed green.

`tools/gallery.mjs` now records a fingerprint of the files it rendered from
(`docs/screenshots/SOURCES.json`), and `test/screenshots.test.js` recomputes it
from the working tree. **Change the panel or `tools/preview.mjs`, and you must run
`node tools/gallery.mjs` in the same commit** — not a later one.
