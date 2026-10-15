import assert from 'node:assert/strict';
import { TemplateWorkflow } from '../src/index.mjs';

// 全部为现场构造的合成占位内容。适配器不访问网络。
const candidates = ['A', 'B', 'C'].map(key => ({
  key,
  label: `模板${key}`,
  prompt: `以${key}结构组织用户明确要求，保持简短。`,
}));

let signalReady;
const ready = new Promise(resolve => { signalReady = resolve; });
const workflow = new TemplateWorkflow({
  candidates,
  history: [],
  recommend: async task => ({ keys: task.candidates.slice(0, task.count).map(item => item.key) }),
  rewrite: async task => ({ text: task.template.prompt.replace('用户明确要求', task.text) }),
  onChange: state => {
    if (state.recommendations.length) signalReady(state);
  },
});

try {
  workflow.edit({ text: '合成需求', images: [] });
  const state = await ready;
  assert.equal(state.recommendations.length, 3);
  const applied = await workflow.apply(state.recommendations[0].key);
  assert.equal(applied, true);
  assert.ok(workflow.getState().text.includes('合成需求'));
  console.log('合成输入 → 停顿等待 → 三个推荐 → 点击改写 → 整体回填：通过');
  console.log('本地假适配器演示，不代表外部匹配、改写或性能结果。');
} finally {
  workflow.dispose();
}
