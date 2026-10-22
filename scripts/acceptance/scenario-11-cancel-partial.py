#!/usr/bin/env python3
# CLO-11 "취소된 실행의 부분 결과" 인수 드라이버 (docs/design/01 §3.2).
# 사용법:
#   python3 scripts/acceptance/scenario-11-cancel-partial.py setup        A→B 요청 생성·전송 (요청 id 를 파일에 남긴다)
#   python3 scripts/acceptance/scenario-11-cancel-partial.py watch <rid>  상태·타임라인을 타임스탬프와 함께 따라간다
#   python3 scripts/acceptance/scenario-11-cancel-partial.py show <rid>   회차별 execution/result(kind 포함) 요약
# 수락·실행·**취소**·재실행·승인은 모두 **웹 UI** 에서 한다 (real 모드 검증이 목적).
import hashlib, json, os, sys, time, urllib.request, urllib.error
sys.path.insert(0, os.path.dirname(__file__))
from fixture_helper import reset_fixture

API = os.environ.get('BATON_API', 'http://127.0.0.1:3001')
LOG_PATH = '/tmp/baton-acceptance-clo11.log'
STATE_PATH = '/tmp/baton-acceptance-clo11.json'


def ts():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


def log(step, msg):
    line = f'[{ts()}] {step}: {msg}'
    print(line, flush=True)
    with open(LOG_PATH, 'a') as f:
        f.write(line + '\n')


def login(email):
    req = urllib.request.Request(API + '/v1/auth/login', data=json.dumps({'email': email, 'password': 'baton-dev-password'}).encode(), method='POST')
    req.add_header('content-type', 'application/json')
    return json.loads(urllib.request.urlopen(req).read().decode())['token']


def call(token, method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method)
    req.add_header('authorization', 'Bearer ' + token)
    if data is not None:
        req.add_header('content-type', 'application/json')
    try:
        with urllib.request.urlopen(req) as r:
            t = r.read().decode()
            return json.loads(t) if t else {}
    except urllib.error.HTTPError as e:
        raise RuntimeError(f'{method} {path} -> {e.code} {e.read().decode()[:400]}')


def upload(token, team, request_id, filename, content):
    b = content.encode()
    sha = hashlib.sha256(b).hexdigest()
    t = call(token, 'POST', '/v1/uploads', {'teamId': team, 'requestId': request_id, 'kind': 'REQUEST_ATTACHMENT', 'filename': filename, 'mimeType': 'text/plain', 'sha256': sha, 'sizeBytes': len(b)})
    put = t['uploadUrl'] if t['uploadUrl'].startswith('http') else API + t['uploadUrl']
    req = urllib.request.Request(put, data=b, method='PUT')
    req.add_header('content-type', 'text/plain')
    urllib.request.urlopen(req).read()
    aid = t.get('artifact', {}).get('id') or t.get('artifactId')
    call(token, 'POST', f'/v1/uploads/{aid}/complete', {'sha256': sha})
    return aid


DOC = """## 로그인 API 500 오류 원인 분석

- 현상: 로그인 API 가 간헐적으로 500 을 반환
- 추정 원인: Redis 연결 실패 (호스트 이름 해석 실패)
- 실제 오류 로그: `RedisConnectionException: redis-servcie: Name or service not known`
- 요청: Kubernetes deployment.yaml 의 REDIS_HOST 설정을 고치고 `./verify.sh` 로 검증해 주세요.
"""
SERVER_LOG = "[2026-09-11 09:30:15] FATAL RedisConnectionException: redis-servcie: Name or service not known\n    at RedisClient.connect (/app/node_modules/redis/client.js:42:11)\n"


def setup():
    # CLO-16: 시작 시 fixture 프로젝트 자동 복원
    reset_fixture(os.environ.get('BATON_FIXTURE_PATH', '/tmp/baton-test-fixtures/backend-api'), logger=log)
    ta, tb = login('a@baton.local'), login('b@baton.local')
    sender_team = call(ta, 'GET', '/v1/me')['teams'][0]['id']
    b_user = call(tb, 'GET', '/v1/me')
    recipient_team = b_user['teams'][0]['id']
    req = call(ta, 'POST', '/v1/requests', {
        'senderTeamId': sender_team, 'recipientTeamId': recipient_team, 'recipientUserId': b_user['id'],
        'title': '로그인 API 오류 해결 요청 (취소 부분 결과 인수)',
        'originalInstruction': '첨부 문서와 server.log 를 보고 로그인 API 500 오류의 원인을 고쳐 주세요. 검증은 ./verify.sh 로 합니다.',
        'documentVersionIds': [], 'artifactIds': []})
    rid = req['id']
    log('11-1', f'A 요청 생성 {rid} state={req["state"]}')
    doc = call(ta, 'POST', f'/v1/requests/{rid}/documents', {'name': 'api-error-analysis.md', 'content': DOC, 'changeNote': '초안'})
    art = upload(ta, sender_team, rid, 'server.log', SERVER_LOG)
    call(ta, 'PATCH', f'/v1/requests/{rid}/draft', {'documentVersionIds': [doc['currentVersionId']], 'artifactIds': [art]})
    r = call(ta, 'POST', f'/v1/requests/{rid}/send')
    log('11-2', f'A 전송 state={r["state"]} (이후 수락·실행·취소·재실행·승인은 웹 UI 에서)')
    json.dump({'requestId': rid, 'senderTeam': sender_team}, open(STATE_PATH, 'w'))
    print(rid)


def summarize(tb, rid):
    d = call(tb, 'GET', f'/v1/requests/{rid}')
    results = {r['executionId']: r for r in (d.get('results') or [])}
    rows = []
    for i, e in enumerate(d.get('executions') or [], 1):
        res = results.get(e['id']) or e.get('result')
        rows.append({'회차': i, 'executionId': e['id'][:8], 'status': e['status'],
                     'resultId': (res or {}).get('id', '-')[:8], 'kind': (res or {}).get('kind', '-'),
                     'changedFiles': (res or {}).get('changedFiles'),
                     'artifacts': len((res or {}).get('artifactIds') or [])})
    return d, rows


# 취소된 회차의 부분 결과가 실제로 조회 가능한지(웹이 보여 주는 것과 같은 경로)까지 확인한다.
def partials(tb, d):
    out = []
    for r in d.get('results') or []:
        if r.get('kind') != 'PARTIAL':
            continue
        arts = []
        for aid in r.get('artifactIds') or []:
            a = call(tb, 'GET', f'/v1/artifacts/{aid}')
            url = a['downloadUrl'] if a['downloadUrl'].startswith('http') else API + a['downloadUrl']
            body = urllib.request.urlopen(url).read().decode('utf8', 'replace')
            arts.append({'kind': a['kind'], 'filename': a['filename'], 'bytes': len(body), 'head': body.splitlines()[:3]})
        out.append({'resultId': r['id'][:8], 'summary': r['summary'][:120], 'changedFiles': r.get('changedFiles'), 'artifacts': arts})
    return out


def watch(rid, limit=900):
    tb = login('b@baton.local')
    seen, last = set(), None
    for _ in range(limit):
        d = call(tb, 'GET', f'/v1/requests/{rid}')
        if d['state'] != last:
            log('state', f'{last} -> {d["state"]}')
            last = d['state']
        for e in d.get('timelineEvents', []):
            if e['id'] in seen:
                continue
            seen.add(e['id'])
            p = e.get('payload') or {}
            if e['eventType'] in ('execution.started', 'execution.finished', 'execution.failed', 'execution.cancelled', 'result.created', 'result.partial_reported', 'result.approved', 'request.completed'):
                log('event', f'{e["eventType"]} {json.dumps({k: str(v)[:60] for k, v in p.items() if k in ("phase", "message", "outcome", "resultId", "reason")}, ensure_ascii=False)}')
        if d['state'] == 'COMPLETED':
            break
        time.sleep(2)
    d, rows = summarize(tb, rid)
    log('summary', json.dumps(rows, ensure_ascii=False))
    log('partial', json.dumps(partials(tb, d), ensure_ascii=False))


def show(rid):
    tb = login('b@baton.local')
    d, rows = summarize(tb, rid)
    print('state:', d['state'])
    print('latestResult:', (d.get('latestResult') or {}).get('id', None))
    print(json.dumps(rows, ensure_ascii=False, indent=2))
    print('partial:', json.dumps(partials(tb, d), ensure_ascii=False, indent=2))


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'setup'
    if cmd == 'setup':
        setup()
    elif cmd == 'watch':
        watch(sys.argv[2])
    elif cmd == 'show':
        show(sys.argv[2])
