#!/usr/bin/env python3
# 개발 터널(ngrok) 환경에서 테스터 안내서의 시나리오 3가지를
# API 로 그대로 재현한다. 안내서가 실제로 되는지 확인하는 용도다.
#
#   BATON_API=https://<api>.ngrok-free.app \
#     python3 scripts/acceptance/scenario-dev-tunnel.py <agentId> <projectId> [--no-exec-s3]
#
# 시나리오
#   S1 사람 지정 요청 : A 가 B 를 지목 → B 수락 → 실행 → 결과 승인 → COMPLETED
#   S2 팀 전체 뿌리기 : A 가 팀에 뿌림(수신자 미지정) → B 가 열람(=claim) → 수락 → 실행 → 승인
#   S3 반려 후 재전송 : A 전송 → B 반려 → A 가 새 revision 으로 재전송 → B 수락
#                      (--no-exec-s3 면 실행은 돌리지 않는다. 실행 경로는 S1·S2 에서 이미 확인했다)
import json, os, sys, time, urllib.request, urllib.error

API = os.environ.get('BATON_API', 'http://127.0.0.1:3001')
PASSWORD = os.environ.get('BATON_DEV_PASSWORD', 'baton-dev-password')
AGENT = sys.argv[1]
PROJECT = sys.argv[2]
RUN_S3_EXEC = '--no-exec-s3' not in sys.argv


def ts():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


def log(step, msg):
    print(f'[{ts()}] {step}: {msg}', flush=True)


def call(token, method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method)
    if token:
        req.add_header('authorization', 'Bearer ' + token)
    if data is not None:
        req.add_header('content-type', 'application/json')
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            t = r.read().decode()
            return json.loads(t) if t else {}
    except urllib.error.HTTPError as e:
        raise RuntimeError(f'{method} {path} -> {e.code} {e.read().decode()[:300]}')


def login(email):
    return call(None, 'POST', '/v1/auth/login', {'email': email, 'password': PASSWORD})['token']


TA, TB = login('a@baton.local'), login('b@baton.local')
ME_A, ME_B = call(TA, 'GET', '/v1/me'), call(TB, 'GET', '/v1/me')
TEAM_A, TEAM_B = ME_A['teams'][0]['id'], ME_B['teams'][0]['id']
log('setup', f'A team={TEAM_A} B team={TEAM_B} agent={AGENT} project={PROJECT}')


def wait_state(rid, targets, timeout=600):
    """요청이 targets 중 하나에 도달할 때까지 기다리며 진행 이벤트를 찍는다."""
    seen, last = set(), None
    deadline = time.time() + timeout
    while time.time() < deadline:
        d = call(TB, 'GET', f'/v1/requests/{rid}')
        if d['state'] != last:
            log('  state', d['state'])
            last = d['state']
        for e in d.get('timelineEvents', []):
            if e['id'] in seen:
                continue
            seen.add(e['id'])
            if e['eventType'] in ('execution.started', 'execution.progress_reported', 'execution.finished', 'execution.failed'):
                p = e.get('payload') or {}
                phase = p.get('phase', '')
                if phase in ('started', 'editing', 'testing', 'test_passed', 'test_failed', 'writing_result', 'finished', 'blocked', 'warning'):
                    log('  진행', f'{phase} {str(p.get("message") or "")[:80]}')
        if d['state'] in targets:
            return d
        time.sleep(2)
    raise RuntimeError(f'{rid} 가 {targets} 에 도달하지 못했습니다 (마지막 {last})')


def run_execution(rid, extra):
    ex = call(TB, 'POST', f'/v1/requests/{rid}/executions', {
        'agentId': AGENT, 'projectId': PROJECT, 'additionalInstruction': extra,
        'policy': {'repository_edit': 'allow', 'deployment_apply': 'deny'},
    })
    log('  실행', f'execution {ex["id"]} 생성')
    d = wait_state(rid, ('RESULT_REVIEW', 'FAILED', 'COMPLETED'))
    res = (d['executions'][-1] or {}).get('result')
    if not res:
        raise RuntimeError('결과가 만들어지지 않았습니다')
    summary = (res.get('summary') or '').strip()
    log('  결과', f'요약 {summary[:70]!r} 변경파일={res["changedFiles"]} 산출물={len(res["artifactIds"])}')
    if not summary or summary == '(요약 없음)':
        raise RuntimeError('요약이 비었습니다 — 결과 수집 경로를 확인하세요')
    call(TB, 'POST', f'/v1/results/{res["id"]}/approve-and-send')
    final = call(TA, 'GET', f'/v1/requests/{rid}')
    log('  승인', f'A 가 보는 상태 {final["state"]}')
    assert final['state'] == 'COMPLETED', final['state']
    return res


results = {}
t0 = time.time()

# ── S1 사람 지정 요청 ─────────────────────────────────────────────
log('S1', '사람 지정 요청 시작')
r = call(TA, 'POST', '/v1/requests', {
    'senderTeamId': TEAM_A, 'recipientTeamId': TEAM_B, 'recipientUserId': ME_B['id'],
    'title': '[S1] add() 가 뺄셈을 합니다',
    'originalInstruction': 'add.js 의 add() 가 a - b 를 반환합니다. 덧셈으로 고치고 `node --test` 로 확인해 주세요.',
    'documentVersionIds': [], 'artifactIds': [],
})
rid1 = r['id']
call(TA, 'POST', f'/v1/requests/{rid1}/send')
log('S1', f'{rid1} 전송')
call(TB, 'POST', f'/v1/requests/{rid1}/review/start')
call(TB, 'POST', f'/v1/requests/{rid1}/accept')
log('S1', '수락')
results['S1'] = run_execution(rid1, '- 저장소 루트의 파일만 고칠 것')
log('S1', '완료')

# ── S2 팀 전체 뿌리기 ─────────────────────────────────────────────
log('S2', '팀 전체 뿌리기 시작 (수신자 미지정)')
r = call(TA, 'POST', '/v1/requests', {
    'senderTeamId': TEAM_A, 'recipientTeamId': TEAM_B,
    'title': '[S2] README 에 실행 방법 한 줄 추가',
    'originalInstruction': 'README.md 에 "설치: 없음 (순수 node)" 한 줄을 추가해 주세요.',
    'documentVersionIds': [], 'artifactIds': [],
})
rid2 = r['id']
assert r.get('recipientUserId') in (None, ''), f'팀 뿌리기인데 수신자가 지정됐다: {r.get("recipientUserId")}'
call(TA, 'POST', f'/v1/requests/{rid2}/send')
log('S2', f'{rid2} 팀에 전송 (수신자 미지정)')
opened = call(TB, 'POST', f'/v1/requests/{rid2}/review/start')
log('S2', f'B 가 열람 state={opened["state"]} (열람만으로는 처리자가 확정되지 않는다)')
# claim 은 accept/return/reject 시점에 원자적으로 일어난다 (requests.controller.ts 의 Swagger 주석).
claimed = call(TB, 'POST', f'/v1/requests/{rid2}/accept')
log('S2', f'B 가 수락 → 처리자 {claimed.get("recipientUserId")} claimedAt={claimed.get("claimedAt")}')
assert claimed.get('recipientUserId') == ME_B['id'], '수락한 사람이 처리자로 확정되어야 한다'
results['S2'] = run_execution(rid2, '- README.md 만 고칠 것')
log('S2', '완료')

# ── S3 반려 후 재전송 ─────────────────────────────────────────────
log('S3', '반려 후 재전송 시작')
r = call(TA, 'POST', '/v1/requests', {
    'senderTeamId': TEAM_A, 'recipientTeamId': TEAM_B, 'recipientUserId': ME_B['id'],
    'title': '[S3] 테스트가 실패합니다',
    'originalInstruction': '테스트가 실패합니다. 고쳐 주세요.',
    'documentVersionIds': [], 'artifactIds': [],
})
rid3 = r['id']
call(TA, 'POST', f'/v1/requests/{rid3}/send')
call(TB, 'POST', f'/v1/requests/{rid3}/review/start')
ret = call(TB, 'POST', f'/v1/requests/{rid3}/return', {'reason': '어떤 테스트가 어떻게 실패하는지 알려 주세요. 실행 명령과 출력이 필요합니다.'})
log('S3', f'반려 state={ret["state"]} 사유={ret.get("returnReason","")[:40]!r}')
assert ret['state'] == 'RETURNED', ret['state']
rev = call(TA, 'POST', f'/v1/requests/{rid3}/revisions', {
    'originalInstruction': '`node --test` 가 add 테스트에서 실패합니다 (expected 5, actual -1). add.js 의 add() 를 덧셈으로 고쳐 주세요.',
    'documentVersionIds': [], 'artifactIds': [],
})
sent = call(TA, 'POST', f'/v1/requests/{rid3}/resend')
log('S3', f'재전송 revisionNo={rev["revisionNo"]} state={sent["state"]}')
call(TB, 'POST', f'/v1/requests/{rid3}/review/start')
acc = call(TB, 'POST', f'/v1/requests/{rid3}/accept')
log('S3', f'수락 state={acc["state"]}')
if RUN_S3_EXEC:
    results['S3'] = run_execution(rid3, '- add.js 만 고칠 것')
else:
    log('S3', '실행은 건너뜀 (--no-exec-s3). 실행 경로는 S1·S2 에서 확인했다')
log('S3', '완료')

print()
log('done', f'S1={rid1} S2={rid2} S3={rid3} 총 {time.time()-t0:.0f}초')
