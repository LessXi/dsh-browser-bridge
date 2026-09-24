/**
 * 给截图用：在会话列表里搜一个**只出现在对话正文里**的词，并留在那里。
 *
 * 与 `probe-session-search.js` 分开是有意的：那个探针在结尾会把查询清空
 * （它要断言「清空后复原」），所以它跑完之后截到的图是完整列表，不是搜索结果。
 * 这个文件只做一件事——输入、等答复、留在原地。
 */
(async () => {
  const find = document.getElementById('find-input')
  if (find === null) return { error: 'no #find-input' }
  const history = document.getElementById('history')
  if (history === null || history.hidden === true) return { error: 'the history view is not open' }

  find.value = 'zstdDecompressSync'
  find.dispatchEvent(new Event('input', { bubbles: true }))

  // 一次 fetch 加一次重绘。帧不够会把「正在搜」截成最终状态。
  for (let index = 0; index < 6; index += 1) {
    await new Promise((resolve) => requestAnimationFrame(resolve))
  }
  await new Promise((resolve) => setTimeout(resolve, 120))
  for (let index = 0; index < 3; index += 1) {
    await new Promise((resolve) => requestAnimationFrame(resolve))
  }

  return {
    typed: find.value,
    /** 画出来的是命中行，而不是「正在搜」 */
    hitRows: history.querySelectorAll('.session-hit').length,
    notes: [...history.querySelectorAll('.search-note')].map((node) => node.textContent.trim()),
    /** 节标题在不在——截图要能看出这一节是什么 */
    headings: [...history.querySelectorAll('.group-label')].map((node) => node.textContent.trim()),
  }
})()
