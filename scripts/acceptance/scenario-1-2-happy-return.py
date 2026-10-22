#!/usr/bin/env python3
# 사용법: python3 scripts/acceptance/<파일> <agentId> <projectId>   (B 로그인 후 GET /v1/agents, /v1/projects 로 확인)
# W4 acceptance driver: API 로 시나리오 1(happy path) + 2(반려/재전송) 를 수행하고 타임스탬프를 기록한다.
import hashlib, json, os, sys, time, urllib.request
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
AGENT = sys.argv[1]
PROJECT = sys.argv[2]
LOG = open('/tmp/baton-acceptance-scenario-1-2.log', 'a')

def ts(): return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
def log(step, msg):
    line = f'[{ts()}] {step}: {msg}'
    print(line); LOG.write(line + '\n'); LOG.flush()

def call(token, method, path, body=None, raw=None, ctype='application/json'):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(API + path, data=data, method=method)
    req.add_header('authorization', 'Bearer ' + token)
    if data is not None: req.add_header('content-type', ctype)
    try:
        with urllib.request.urlopen(req) as r:
            t = r.read().decode()
            return json.loads(t) if t else {}
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        raise RuntimeError(f'{method} {path} -> {e.code} {body[:300]}')

def upload(token, request_id, filename, content):
    b = content.encode(); sha = hashlib.sha256(b).hexdigest()
    t = call(token, 'POST', '/v1/uploads', {'teamId': TEAM, 'requestId': request_id, 'kind': 'REQUEST_ATTACHMENT', 'filename': filename, 'mimeType': 'text/plain', 'sha256': sha, 'sizeBytes': len(b)})
    put = t['uploadUrl'] if t['uploadUrl'].startswith('http') else API + t['uploadUrl']
    req = urllib.request.Request(put, data=b, method='PUT'); req.add_header('content-type', 'text/plain')
    urllib.request.urlopen(req).read()
    aid = t.get('artifact', {}).get('id') or t.get('artifactId')
    call(token, 'POST', f'/v1/uploads/{aid}/complete', {'sha256': sha})
    return aid

def state(token, rid): return call(token, 'GET', f'/v1/requests/{rid}')

DOC_V1 = """## 로그인 API 500 오류 원인 분석

- 현상: 로그인 API 가 간헐적으로 500 을 반환
- 추정 원인: Redis 연결 실패 (호스트 이름 해석 실패)
- 요청: Kubernetes deployment.yaml 의 REDIS_HOST 설정을 확인하고 수정안을 작성해 주세요.
"""
DOC_V2 = DOC_V1 + """
## (v2) 보완: 실제 오류 로그
```
[2026-09-04 12:30:15] FATAL RedisConnectionException: redis-servcie: Name or service not known
```
- 발생 시각: 2026-09-04 12:30:15 KST, 로그인 시도 5회 연속 실패
- 검증 방법: 저장소 루트의 ./verify.sh 가 DEPLOYMENT_VERIFIED_SUCCESS 를 출력해야 합니다.
"""
SERVER_LOG = "[2026-09-04 12:30:15] FATAL RedisConnectionException: redis-servcie: Name or service not known\n    at RedisClient.connect (/app/node_modules/redis/client.js:42:11)\n    at AuthController.login (/app/src/auth/auth.controller.ts:58:19)\n"

t0 = time.time()
# CLO-16: 시작 시 fixture 프로젝트를 초기 결함 상태(redis-servcie 오타)로 자동 복원
try:
    projs = call(TB, 'GET', '/v1/projects')
    proj_path = next((p.get('localPathHint') for p in projs if p.get('id') == PROJECT and p.get('localPathHint')), None)
except Exception:
    proj_path = None
reset_fixture(proj_path or os.environ.get('BATON_FIXTURE_PATH', '/tmp/baton-test-fixtures/backend-api'), logger=log)

# 1-2 A: 요청 생성
b_user = call(TB, 'GET', '/v1/me')
req = call(TA, 'POST', '/v1/requests', {'senderTeamId': SENDER_TEAM, 'recipientTeamId': RECIPIENT_TEAM, 'recipientUserId': b_user['id'], 'title': '로그인 API 오류 해결 요청', 'originalInstruction': '첨부한 분석 문서와 server.log 를 확인하고 로그인 API 500 오류의 원인을 해결해 주세요. 검증은 ./verify.sh 로 합니다.', 'documentVersionIds': [], 'artifactIds': []})
rid = req['id']; log('1-2', f'request created {rid} state={req["state"]}')
doc = call(TA, 'POST', f'/v1/requests/{rid}/documents', {'name': 'api-error-analysis.md', 'content': DOC_V1, 'changeNote': '초안'})
art = upload(TA, rid, 'server.log', SERVER_LOG)
call(TA, 'PATCH', f'/v1/requests/{rid}/draft', {'documentVersionIds': [doc['currentVersionId']], 'artifactIds': [art]})
log('1-2', f'document v1 {doc["currentVersionId"]} + artifact {art} attached')
# 1-3 A: 전송
r = call(TA, 'POST', f'/v1/requests/{rid}/send'); log('1-3', f'sent state={r["state"]}')
time.sleep(2)
# 2-2 B: 열람 → 반려
r = call(TB, 'POST', f'/v1/requests/{rid}/review/start'); log('2-2', f'review started state={r["state"]}')
r = call(TB, 'POST', f'/v1/requests/{rid}/return', {'reason': '실제 오류 로그 파일이 누락되었습니다. server.log 와 발생 시각을 추가해 주세요.'}); log('2-2', f'returned state={r["state"]} reason={r.get("returnReason")}')
# 2-3 A: 새 revision + 재전송
doc2 = call(TA, 'POST', f'/v1/requests/{rid}/documents', {'name': 'api-error-analysis.v2.md', 'content': DOC_V2, 'changeNote': '반려 사유 반영: 오류 로그·발생 시각 추가'})
art2 = upload(TA, rid, 'server.log', SERVER_LOG)
rev = call(TA, 'POST', f'/v1/requests/{rid}/revisions', {'originalInstruction': '반려 사유를 반영해 실제 오류 로그와 발생 시각을 추가했습니다. deployment.yaml 의 REDIS_HOST 오타를 수정하고 ./verify.sh 로 검증해 주세요.', 'documentVersionIds': [doc2['currentVersionId']], 'artifactIds': [art2]})
r = call(TA, 'POST', f'/v1/requests/{rid}/resend'); log('2-3', f'resent revisionNo={rev["revisionNo"]} state={r["state"]}')
time.sleep(2)
# 1-6 B: 열람 → 수락
r = call(TB, 'POST', f'/v1/requests/{rid}/review/start'); log('1-6', f'review started state={r["state"]}')
r = call(TB, 'POST', f'/v1/requests/{rid}/accept'); log('1-6', f'accepted state={r["state"]}')
# 1-7 B: 실행 준비 → 실행
ex = call(TB, 'POST', f'/v1/requests/{rid}/executions', {'agentId': AGENT, 'projectId': PROJECT, 'additionalInstruction': '운영 환경은 변경하지 마. Kubernetes 설정(deployment.yaml)만 확인하고 오타를 수정한 뒤 ./verify.sh 로 검증해줘.', 'policy': {'repository_edit': 'allow', 'deployment_apply': 'deny'}})
log('1-7', f'execution {ex["id"]} created state=READY_TO_RUN')
t_exec = time.time()
# 1-8~1-10: 데몬 실행 대기
seen = set(); last_state = None
for i in range(480):
    d = state(TB, rid)
    st = d['state']
    if st != last_state: log('1-8', f'request state -> {st}'); last_state = st
    for e in d.get('timelineEvents', []):
        if e['id'] in seen: continue
        seen.add(e['id'])
        if e['eventType'] in ('execution.started', 'execution.progress_reported', 'execution.finished', 'execution.failed', 'result.created'):
            p = e.get('payload') or {}
            log('1-9', f'{e["eventType"]} {p.get("phase","")} {str(p.get("message") or p.get("reason") or "")[:90]}')
    if st in ('RESULT_REVIEW', 'FAILED', 'COMPLETED'): break
    time.sleep(2)
log('1-10', f'execution finished state={last_state} elapsed={time.time()-t_exec:.0f}s')
d = state(TB, rid)
execs = d['executions']; res = execs[-1].get('result')
if res:
    log('1-10', f'result summary={res["summary"][:100]!r} changedFiles={res["changedFiles"]} artifacts={len(res["artifactIds"])} testSummary={str(res.get("testSummary"))[:60]!r}')
    # 1-11 B: 결과 승인
    r = call(TB, 'POST', f'/v1/results/{res["id"]}/approve-and-send'); log('1-11', f'approved reviewStatus={r["reviewStatus"]}')
    d = state(TA, rid); log('1-12', f'A view state={d["state"]} completedAt={d.get("completedAt")}')
json.dump({'requestId': rid, 'executionId': ex['id'], 'resultId': res['id'] if res else None, 'docV1': doc['currentVersionId'], 'docV2': doc2['currentVersionId'], 'elapsed': time.time() - t0}, open('/tmp/baton-acceptance-scenario-1-2.json', 'w'))
log('done', f'total {time.time()-t0:.0f}s')
