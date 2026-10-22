#!/usr/bin/env python3
# 사용법: python3 scripts/acceptance/<파일> <agentId> <projectId>   (B 로그인 후 GET /v1/agents, /v1/projects 로 확인)
# W4 acceptance driver 2: 시나리오 4(FAILED → D4 재실행) + 시나리오 3(거절)
import json, os, sys, time, urllib.request
sys.path.insert(0, os.path.dirname(__file__))
from fixture_helper import reset_fixture

API = os.environ.get('BATON_API', 'http://127.0.0.1:3001')

def login(email):
    req = urllib.request.Request(API + '/v1/auth/login', data=json.dumps({'email': email, 'password': 'baton-dev-password'}).encode(), method='POST')
    req.add_header('content-type', 'application/json')
    return json.loads(urllib.request.urlopen(req).read().decode())['token']
TA = login('a@baton.local')
TB = login('b@baton.local')
# 05 조직·팀: 요청은 senderTeamId(A 의 팀)·recipientTeamId(B 의 팀)·recipientUserId(사람 지정) 로 만든다.
# 팀 id 는 seed 에 고정돼 있지 않으므로 /v1/me 에서 읽는다 (backend: A, infra: B).
def _first_team(token):
    me = None
    import urllib.request as _u
    req = _u.Request(API + '/v1/me'); req.add_header('authorization', 'Bearer ' + token)
    me = json.loads(_u.urlopen(req).read().decode())
    return me['teams'][0]['id']
SENDER_TEAM = _first_team(TA)
RECIPIENT_TEAM = _first_team(TB)
TEAM = SENDER_TEAM  # 업로드(첨부)는 발신 팀 소유
AGENT, PROJECT = sys.argv[1], sys.argv[2]
FIX = '/tmp/baton-test-fixtures/backend-api'
LOG = open('/tmp/baton-acceptance-scenario-4-3.log', 'a')

def ts(): return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
def log(step, msg):
    line = f'[{ts()}] {step}: {msg}'; print(line); LOG.write(line + '\n'); LOG.flush()
def call(token, method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method)
    req.add_header('authorization', 'Bearer ' + token)
    if data is not None: req.add_header('content-type', 'application/json')
    try:
        with urllib.request.urlopen(req) as r:
            t = r.read().decode(); return json.loads(t) if t else {}
    except urllib.error.HTTPError as e:
        raise RuntimeError(f'{method} {path} -> {e.code} {e.read().decode()[:300]}')
def state(token, rid): return call(token, 'GET', f'/v1/requests/{rid}')
def wait_state(rid, targets, timeout=480, tag='wait'):
    seen = set(); last = None
    for _ in range(timeout // 2):
        d = state(TB, rid)
        if d['state'] != last: log(tag, f'request state -> {d["state"]}'); last = d['state']
        for e in d.get('timelineEvents', []):
            if e['id'] in seen: continue
            seen.add(e['id'])
            if e['eventType'] in ('execution.started', 'execution.failed', 'execution.finished', 'execution.progress_reported'):
                p = e.get('payload') or {}
                if e['eventType'] != 'execution.progress_reported' or p.get('phase') in ('started', 'editing', 'testing', 'test_passed', 'finished', 'failed', 'writing_result'):
                    log(tag, f'{e["eventType"]} {p.get("phase","")} {str(p.get("message") or p.get("reason") or "")[:100]}')
        if d['state'] in targets: return d
        time.sleep(2)
    raise RuntimeError('timeout waiting ' + str(targets))

b = call(TB, 'GET', '/v1/me')
# CLO-16: 시작 시 fixture 프로젝트를 초기 결함 상태로 자동 복원
try:
    projs = call(TB, 'GET', '/v1/projects')
    proj_path = next((p.get('localPathHint') for p in projs if p.get('id') == PROJECT and p.get('localPathHint')), None)
    if proj_path: FIX = proj_path
except Exception:
    pass
reset_fixture(FIX, logger=log)

# ---- 시나리오 4: FAILED → D4 재실행 ----
req = call(TA, 'POST', '/v1/requests', {'senderTeamId': SENDER_TEAM, 'recipientTeamId': RECIPIENT_TEAM, 'recipientUserId': b['id'], 'title': '[실패 경로] deployment.yaml 검증 요청', 'originalInstruction': 'deployment.yaml 의 REDIS_HOST 값을 확인하고 ./verify.sh 가 통과하는지 확인해 주세요.', 'documentVersionIds': [], 'artifactIds': []})
rid = req['id']; log('4-0', f'request {rid} created')
call(TA, 'POST', f'/v1/requests/{rid}/send'); call(TB, 'POST', f'/v1/requests/{rid}/review/start'); call(TB, 'POST', f'/v1/requests/{rid}/accept'); log('4-0', 'sent → reviewing → accepted')
# 프로젝트 경로를 잠시 없앤다 (의도적 결함: 존재하지 않는 프로젝트 경로)
os.rename(FIX, FIX + '.hidden'); log('4-1', f'fixture renamed away → 프로젝트 경로 없음 유도')
try:
    ex1 = call(TB, 'POST', f'/v1/requests/{rid}/executions', {'agentId': AGENT, 'projectId': PROJECT, 'additionalInstruction': '검증만 수행', 'policy': {'repository_edit': 'allow', 'deployment_apply': 'deny'}})
    log('4-1', f'execution {ex1["id"]} created (READY_TO_RUN)')
    d = wait_state(rid, ('FAILED', 'RESULT_REVIEW'), tag='4-2')
    e1 = [e for e in d['executions'] if e['id'] == ex1['id']][0]
    log('4-2', f'execution status={e1["status"]} failureReason={str(e1.get("failureReason"))[:120]!r}')
finally:
    if os.path.exists(FIX + '.hidden'): os.rename(FIX + '.hidden', FIX); log('4-3', 'fixture restored')
# D4: FAILED 상태에서 재실행 → 새 Execution + READY_TO_RUN 복귀
ex2 = call(TB, 'POST', f'/v1/requests/{rid}/executions', {'agentId': AGENT, 'projectId': PROJECT, 'additionalInstruction': '오류 원인을 재확인하고 verify.sh 테스트 통과를 다시 시도해줘.', 'policy': {'repository_edit': 'allow', 'deployment_apply': 'deny'}})
log('4-3', f'retry execution {ex2["id"]} created previousExecutionId={ex2.get("previousExecutionId")}')
d = wait_state(rid, ('RESULT_REVIEW', 'FAILED'), tag='4-4')
e2 = [e for e in d['executions'] if e['id'] == ex2['id']][0]
log('4-4', f'retry execution status={e2["status"]} result={bool(e2.get("result"))} state={d["state"]}')
if e2.get('result'):
    r = call(TB, 'POST', f'/v1/results/{e2["result"]["id"]}/approve-and-send'); log('4-4', f'approved → {state(TA, rid)["state"]}')
# ---- 시나리오 3: 거절 ----
req3 = call(TA, 'POST', '/v1/requests', {'senderTeamId': SENDER_TEAM, 'recipientTeamId': RECIPIENT_TEAM, 'recipientUserId': b['id'], 'title': '[거절 경로] 데이터팀 소관 요청', 'originalInstruction': '데이터 파이프라인 설정을 검토해 주세요.', 'documentVersionIds': [], 'artifactIds': []})
rid3 = req3['id']; call(TA, 'POST', f'/v1/requests/{rid3}/send'); call(TB, 'POST', f'/v1/requests/{rid3}/review/start')
r = call(TB, 'POST', f'/v1/requests/{rid3}/reject', {'reason': '해당 모듈은 인프라팀 소관이 아닌 데이터팀 담당입니다.'}); log('3-1', f'rejected state={r["state"]}')
try:
    call(TA, 'POST', f'/v1/requests/{rid3}/resend'); log('3-2', 'resend after reject unexpectedly succeeded')
except RuntimeError as e:
    log('3-2', f'resend after reject blocked: {str(e)[:100]}')
json.dump({'failedRequestId': rid, 'ex1': ex1['id'], 'ex2': ex2['id'], 'rejectedRequestId': rid3}, open('/tmp/baton-acceptance-scenario-4-3.json', 'w'))
log('done', 'scenario 4 + 3 finished')
