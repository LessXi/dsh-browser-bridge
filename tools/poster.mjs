/**
 * Render the README's hero images: the panel as a product, not as a file list.
 *
 * The gallery in `gallery.mjs` answers "what does each state look like". That is
 * the right instrument for a reference, and the wrong one for a front page: it
 * pastes the panel at 330px in pairs next to a caption that argues about CSS.
 * A reader deciding whether to install this learns the features before they
 * learn what the thing is for.
 *
 * So a poster is a different artefact with a different job. It states one claim,
 * shows the product once, at size, and puts numbers underneath as evidence. The
 * panel itself is never redrawn or mocked up — it is the same PNG the gallery
 * produced, placed on a stage by real CSS in the same real Chrome. Anything the
 * poster says is therefore a claim about an image that exists.
 *
 * Why the stage is HTML rather than image compositing: this repository has no
 * dependencies and needs none. A browser is already required to take the
 * screenshots at all, and it is a better typesetter than anything that would
 * have to be added to rotate a PNG. `--force-device-scale-factor=2` comes along
 * for free.
 *
 * The claims are not free-form. Each poster's headline and its numbers are
 * declared below with the file they are about, so a number that stops being
 * true is a number someone has to edit here — it cannot drift in silence the
 * way prose does.
 *
 * Usage:
 *   node tools/poster.mjs           # write docs/posters/
 *   node tools/poster.mjs --check   # fail if any poster is missing
 *
 * @module dsh-browser-bridge/tools/poster
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const SHOTS = join(REPO, 'docs', 'screenshots')
const OUT = join(REPO, 'docs', 'posters')

/** Where Chrome lives, in the order worth trying. */
const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  join(process.env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
]

/**
 * Find a Chrome to render with.
 *
 * @returns {string} An absolute path that exists.
 */
function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (candidate.length > 0 && existsSync(candidate)) return candidate
  }
  throw new Error('no Chrome found; the posters are rendered by a real browser')
}

/**
 * The posters.
 *
 * `claim` is the sentence the whole image is arguing for. It is written as a
 * claim about the reader's situation rather than as a feature name, because a
 * feature name is what the feature list already says.
 *
 * `stats` are evidence and each one has to be checkable elsewhere in this
 * repository. Two rules, both learned the hard way:
 *
 * - Never state a number the product does not have. An early draft of the first
 *   poster said "0 permissions" because it sounded like a virtue; the manifest
 *   asks for `debugger`, `tabs` and host access to every site, so that was a
 *   false claim about security on the front page. Check the manifest, not the
 *   adjective.
 * - Prefer a number that measures the reader's pain to one that measures the
 *   implementation. "60 rows in a window" is an implementation detail; "6969
 *   rows in a session" is why they need the panel.
 */
const POSTERS = [
  {
    file: 'hero.png',
    shot: 'conversation.png',
    kicker: 'DSH Browser Bridge',
    claim: '你的浏览器，<em>成为对话的一部分</em>',
    lede: '一个 Chrome 侧栏面板。会话能读你正在看的页面，能点它，并且每次都先问你。',
    stats: [
      { value: '6969', label: '作者最长的会话，行' },
      { value: '60', label: '行一个窗口' },
      { value: '2.4', unit: 'ms', label: '一屏渲染' },
    ],
  },
  {
    file: 'search.png',
    shot: 'search.png',
    kicker: '搜索',
    claim: '在 6969 行里，<em>直接落到那一句</em>',
    lede: '搜索在宿主里做，不在屏幕上。面板只拿 60 行，却回答得了整段会话有没有这个词。',
    stats: [
      { value: '116', label: '次翻页，没有搜索时' },
      { value: '1', label: '次输入' },
      { value: '30', label: '条命中的上限' },
    ],
  },
  {
    file: 'approval.png',
    shot: 'approval.png',
    kicker: '审批',
    claim: '它替你点之前，<em>先问你一次</em>',
    lede: '每一次站点操作都要批准。三个按钮等权，没有默认项——同意不该被暗示。',
    stats: [
      { value: '3', label: '个等权按钮' },
      { value: '0', label: '个默认项' },
      { value: '1', label: '次授权，按站点' },
    ],
  },
]

/**
 * The stage.
 *
 * Written as one stylesheet rather than per-poster CSS because the posters are
 * a series: a reader scrolling them should feel one hand. The decisions that
 * matter, and why:
 *
 * - The canvas is a fixed 1000x1180 and the product takes whatever room is
 *   left over, rather than the page growing to fit the product. Chrome's
 *   `--screenshot` captures the window and not the document — measured, not
 *   assumed: a 900px-tall document in a 300px window came out 400x300 — so a
 *   page whose height follows its content is a page that gets cropped. Sizing
 *   the stage first means the copy can wrap to any number of lines without the
 *   poster losing its bottom, and no poster ends up with a band of empty
 *   background where the product should be.
 * - The background is a radial gradient, not a flat colour. A flat fill makes
 *   the product's edge sit flush against the page and the device stops reading
 *   as an object.
 * - The device carries three shadows: a hairline that draws its edge, a close
 *   one that gives it thickness, and a wide accent-tinted one that makes it
 *   float. A single shadow reads as a rectangle pasted on.
 * - Emphasis inside a headline is colour, never bold: bolding mid-sentence
 *   wrecks the letter-spacing of the line it sits in.
 *
 * @param {object} poster - One entry of {@link POSTERS}.
 * @param {string} shotDataUri - The panel image, inlined so Chrome needs no second load.
 * @returns {string} A complete HTML document.
 */
function stage(poster, shotDataUri) {
  const stats = poster.stats
    .map((stat) => `      <div class="stat">
        <b>${stat.value}${stat.unit === undefined ? '' : `<small>${stat.unit}</small>`}</b>
        <span>${stat.label}</span>
      </div>`)
    .join('\n')

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html { background: #08080c; }
  body {
    width: 1000px;
    height: 1180px;
    display: flex;
    flex-direction: column;
    background: radial-gradient(120% 80% at 50% 0%, #1d2340 0%, #12141f 38%, #08080c 78%);
    padding: 62px 0 58px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
                 "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    color: #f5f6fa;
    -webkit-font-smoothing: antialiased;
  }
  .copy { flex: none; }
  .kicker {
    text-align: center; font-size: 14px; font-weight: 600;
    letter-spacing: 0.16em; text-transform: uppercase;
    color: #6f7bd8; margin-bottom: 20px;
  }
  h1 {
    text-align: center; font-size: 47px; line-height: 1.26;
    font-weight: 700; letter-spacing: -0.01em; padding: 0 76px;
  }
  h1 em {
    font-style: normal;
    background: linear-gradient(92deg, #8b9aff, #4fd1c5);
    -webkit-background-clip: text; background-clip: text; color: transparent;
  }
  .lede {
    text-align: center; font-size: 17px; line-height: 1.7;
    color: #9aa1b8; padding: 0 146px; margin-top: 22px;
  }
  /* min-height: 0 is what lets this shrink: a flex item's floor is its
     content by default, so without it the product would push the numbers off
     the canvas instead of scaling down to fit. */
  .stage {
    flex: 1; min-height: 0;
    display: flex; align-items: center; justify-content: center;
    margin: 40px 0 36px;
  }
  .device {
    height: 100%;
    border-radius: 21px; overflow: hidden;
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, 0.09),
      0 22px 45px -12px rgba(0, 0, 0, 0.75),
      0 60px 120px -30px rgba(0, 0, 0, 0.65),
      0 0 90px -20px rgba(88, 108, 235, 0.35);
  }
  .device img { display: block; height: 100%; width: auto; }
  .stats { flex: none; display: flex; justify-content: center; gap: 78px; }
  .stat { text-align: center; }
  .stat b {
    display: block; font-size: 33px; font-weight: 700; letter-spacing: -0.02em;
    background: linear-gradient(180deg, #ffffff, #a8b0cc);
    -webkit-background-clip: text; background-clip: text; color: transparent;
  }
  .stat b small { font-size: 17px; font-weight: 600; }
  .stat span { display: block; margin-top: 8px; font-size: 13px; color: #7b83a0; }
</style>
</head>
<body>
  <div class="copy">
    <p class="kicker">${poster.kicker}</p>
    <h1>${poster.claim}</h1>
    <p class="lede">${poster.lede}</p>
  </div>
  <div class="stage"><div class="device"><img src="${shotDataUri}" alt=""></div></div>
  <div class="stats">
${stats}
  </div>
</body>
</html>
`
}

/** Render one poster and report its size. */
function render(poster, chrome) {
  const shotPath = join(SHOTS, poster.shot)
  if (!existsSync(shotPath)) {
    throw new Error(`${poster.shot} is missing; run \`node tools/gallery.mjs\` first`)
  }
  const dataUri = `data:image/png;base64,${readFileSync(shotPath).toString('base64')}`

  // The canvas is a fixed 1000x1180 and the stage inside it flexes. Chrome's
  // `--screenshot` captures the window rather than the document — measured, not
  // assumed: a 900px document in a 300px window came out 400x300 — so a page
  // free to grow to its content is a page that gets cropped.
  const work = join(OUT, `${poster.file}.html`)
  writeFileSync(work, stage(poster, dataUri))
  const out = join(OUT, poster.file)
  const result = spawnSync(chrome, [
    '--headless',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=2',
    `--screenshot=${out}`,
    '--window-size=1000,1180',
    `file:///${work.replace(/\\/g, '/')}`,
  ], { encoding: 'utf8' })
  if (!existsSync(out)) {
    throw new Error(`${poster.file} was not written:\n${(result.stderr || '').trim().slice(-400)}`)
  }
  rmSync(work, { force: true })
  const size = statSync(out).size
  if (size < 20_000) {
    throw new Error(`${poster.file} is only ${size} bytes — the stage probably did not render`)
  }
  return size
}

const checking = process.argv.includes('--check')

if (checking) {
  const missing = POSTERS.filter((p) => !existsSync(join(OUT, p.file)))
  if (missing.length > 0) {
    process.stderr.write(`missing posters: ${missing.map((p) => p.file).join(', ')}\n`)
    process.stderr.write('run `node tools/poster.mjs` to regenerate them\n')
    process.exit(1)
  }
  process.stdout.write(`${POSTERS.length} posters present in docs/posters/\n`)
} else {
  const chrome = findChrome()
  mkdirSync(OUT, { recursive: true })
  for (const poster of POSTERS) {
    const size = render(poster, chrome)
    process.stdout.write(`${poster.file.padEnd(16)} ${String(Math.round(size / 1024)).padStart(5)} KB\n`)
  }
  process.stdout.write(`\n${POSTERS.length} posters written to docs/posters/\n`)
}
