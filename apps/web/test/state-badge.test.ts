import assert from 'node:assert/strict';
import test from 'node:test';
import { STATE_LABELS } from '../components/ui/badge';

const hue = (className: string) => className.match(/\bbg-([a-z]+)-\d+/)?.[1] ?? className.match(/\bbg-([a-z]+)\b/)?.[1];

test('상태 배지는 서로 다른 색 계열을 쓴다(임시저장·철회됨은 채움 여부로 구분)', () => {
  const seen = new Map<string, string>();
  for (const [state, info] of Object.entries(STATE_LABELS)) {
    if (state === 'DRAFT') continue; // 흰 바탕 점선 테두리
    const h = hue(info.className)!;
    assert.ok(h, state);
    assert.equal(seen.get(h), undefined, `${state} 와 ${seen.get(h)} 가 같은 색 계열(${h})`);
    seen.set(h, state);
  }
  assert.match(STATE_LABELS.DRAFT.className, /border-dashed/);
});

test('수락됨과 완료됨은 한눈에 구분된다(완료는 꽉 찬 배지)', () => {
  assert.notEqual(hue(STATE_LABELS.ACCEPTED.className), hue(STATE_LABELS.COMPLETED.className));
  assert.match(STATE_LABELS.COMPLETED.className, /text-white/);
  assert.doesNotMatch(STATE_LABELS.ACCEPTED.className, /text-white/);
});
