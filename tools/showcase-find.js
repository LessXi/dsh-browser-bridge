/**
 * 给门面图用：在查找栏里真的输入一个词，并等面板答完。
 *
 * 场景自带的 `click: '#find-open'` 只把栏打开，输入框还是空的，于是截图上是
 * 占位符加「无结果」——拿它当门面图会让人以为搜索不能用。
 *
 * 这里按 `aria-expanded` 确认栏真的开了（dom-shim 不解析标记里的 hidden，
 * 预览页同理不能靠 hidden 判断），再设值并派发 input，等两帧让请求回来。
 */
(async () => {
  const button = document.getElementById('find-open')
  const field = document.getElementById('find-input')
  const count = document.getElementById('find-count')
  if (field === null) return { error: 'no #find-input' }

  const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()))
  const settle = async (frames) => {
    for (let at = 0; at < frames; at += 1) await frame()
  }

  // 打开栏：只在还没开的时候点，点两次会把它关掉。
  if (button !== null && button.getAttribute('aria-expanded') !== 'true') {
    button.click()
    await settle(4)
  }

  field.value = 'zebra'
  field.dispatchEvent(new Event('input', { bubbles: true }))
  // 搜索是往宿主发请求，要等回复落地再截图。
  await settle(45)

  return {
    typed: field.value,
    count: count === null ? null : count.textContent.trim(),
    /** 命中的行是否真的在屏上被描边 */
    hitRows: document.querySelectorAll('.row.hit, .reasoning.hit').length,
    /** 匹配字符本身是否被 CSS Custom Highlight 标出 */
    needleRanges: globalThis.CSS?.highlights?.get('dsh-needle') === undefined ? 0 : 1,
  }
})()
