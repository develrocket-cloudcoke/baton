#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Baton 인수 테스트 fixture 자동 초기화 도우미 (CLO-16)
테스트 드라이버 실행 시 fixture 프로젝트를 초기 결함 상태(redis-servcie 오타)로 되돌립니다.
"""

import os
import subprocess
import sys

DEFAULT_FIXTURE_PATH = '/tmp/baton-test-fixtures/backend-api'


def reset_fixture(project_path=None, logger=None):
    """
    지정된 fixture 프로젝트 디렉터리를 초기 상태로 되돌립니다.
    1. 사용자가 작성한 실제 프로젝트 파일을 지우지 않도록 fixture 안전 검사를 수행합니다.
    2. git 저장소인 경우: `git checkout HEAD -- .` 및 `git clean -fd` 로 초기 커밋 상태로 복원합니다.
    3. 디렉터리가 없거나 git 저장소가 아닌 경우: `scripts/fixture-backend-api.sh` 를 호출해 새로 생성합니다.
    """
    def _log(msg):
        if logger:
            logger('fixture', msg)
        else:
            print(f'[fixture] {msg}', flush=True)

    target_path = project_path or os.environ.get('BATON_FIXTURE_PATH', DEFAULT_FIXTURE_PATH)
    target_path = os.path.abspath(target_path)

    # 1. 안전 검사: 사용자의 작업 저장소나 임의의 루트 디렉터리가 초기화되지 않도록 검증
    is_safe_fixture_path = (
        target_path.startswith('/tmp/baton-test-fixtures') or
        'test-fixtures' in target_path or
        os.path.basename(target_path).startswith('fixture') or
        os.path.basename(target_path) in ('backend-api', 'infra-tools')
    )

    if not is_safe_fixture_path:
        _log(f"안전 검사 건너뜀: {target_path} 는 fixture 디렉터리로 식별되지 않아 되돌리기를 생략합니다.")
        return False

    git_dir = os.path.join(target_path, '.git')
    has_git = os.path.isdir(git_dir)

    # 2. git 저장소인 경우 git checkout . + clean -fd 수행
    if has_git:
        try:
            # git 커밋 메시지 또는 작성자에 fixture 흔적이 있는지 추가 안전 확인
            log_res = subprocess.run(
                ['git', 'log', '-1', '--pretty=%B'],
                cwd=target_path,
                capture_output=True,
                text=True,
                check=False
            )
            commit_msg = (log_res.stdout or '').lower()
            if 'fixture' not in commit_msg and not target_path.startswith('/tmp/'):
                _log(f"안전 검사: 커밋 메시지에 'fixture' 가 없어 복원을 건너뜁니다: {commit_msg.strip()}")
                return False

            # 변경된 파일 되돌리기 (오타 복구: redis-service -> redis-servcie)
            subprocess.run(['git', 'checkout', 'HEAD', '--', '.'], cwd=target_path, check=True, capture_output=True)
            # 실행 중 생성된 새 파일/디렉터리 제거
            subprocess.run(['git', 'clean', '-fd'], cwd=target_path, check=True, capture_output=True)
            _log(f"git checkout . + clean -fd 완료 (초기 오타 상태로 복원): {target_path}")
            return True
        except subprocess.CalledProcessError as e:
            _log(f"git 복원 중 오류 발생 ({e}), fixture-backend-api.sh 로 재생성을 시도합니다.")

    # 3. 디렉터리가 없거나 git 저장소가 아닌 경우 스크립트로 신규 생성
    script_path = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'fixture-backend-api.sh'))
    if os.path.isfile(script_path):
        try:
            subprocess.run([script_path, target_path], check=True, capture_output=True)
            _log(f"fixture-backend-api.sh 로 fixture 신규 생성 완료: {target_path}")
            return True
        except subprocess.CalledProcessError as e:
            _log(f"fixture 스크립트 실행 실패: {e}")
            return False
    else:
        _log(f"fixture 스크립트를 찾을 수 없습니다: {script_path}")
        return False


if __name__ == '__main__':
    p = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_FIXTURE_PATH
    success = reset_fixture(p)
    sys.exit(0 if success else 1)
