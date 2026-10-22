import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  detectOsVersion,
  deviceInfo,
  getCachedOsVersion,
  resetCachedOsVersionForTesting
} from '../src/transport/device-info';

test('device-info: BATON_OS_VERSION 환경변수가 있으면 플랫폼과 무관하게 최우선 사용한다', () => {
  const result = detectOsVersion({
    envOsVersion: 'macOS 99.9.9-custom',
    platform: 'darwin',
    swVersRunner: () => '26.5.2'
  });
  assert.equal(result, 'macOS 99.9.9-custom');
});

test('device-info: macOS (darwin) 에서 sw_vers 가 제품 버전을 반환하면 macOS X.Y.Z 형식으로 반환한다', () => {
  const result = detectOsVersion({
    platform: 'darwin',
    swVersRunner: () => '26.5.2\n',
    osRelease: () => '25.5.0'
  });
  assert.equal(result, 'macOS 26.5.2');
});

test('device-info: macOS (darwin) 에서 sw_vers 실패 시 커널 대신 macOS <release> 로 폴백한다', () => {
  const result = detectOsVersion({
    platform: 'darwin',
    swVersRunner: () => {
      throw new Error('command not found');
    },
    osRelease: () => '25.5.0'
  });
  assert.equal(result, 'macOS 25.5.0');
});

test('device-info: Linux 에서 /etc/os-release 의 PRETTY_NAME 을 우선 파싱한다', () => {
  const osReleaseSample = `
NAME="Ubuntu"
VERSION="22.04.4 LTS (Jammy Jellyfish)"
ID=ubuntu
ID_LIKE=debian
PRETTY_NAME="Ubuntu 22.04.4 LTS"
VERSION_ID="22.04"
`;
  const result = detectOsVersion({
    platform: 'linux',
    osReleaseReader: () => osReleaseSample,
    osRelease: () => '5.15.0-generic'
  });
  assert.equal(result, 'Ubuntu 22.04.4 LTS');
});

test('device-info: Linux 에서 PRETTY_NAME 이 없으면 NAME + VERSION 을 조합한다', () => {
  const osReleaseSample = `
NAME="Debian GNU/Linux"
VERSION="12 (bookworm)"
ID=debian
`;
  const result = detectOsVersion({
    platform: 'linux',
    osReleaseReader: () => osReleaseSample,
    osRelease: () => '6.1.0'
  });
  assert.equal(result, 'Debian GNU/Linux 12 (bookworm)');
});

test('device-info: Linux 에서 os-release 파일이 없으면 Linux <release> 로 폴백한다', () => {
  const result = detectOsVersion({
    platform: 'linux',
    osReleaseReader: () => null,
    osRelease: () => '5.10.0-custom'
  });
  assert.equal(result, 'Linux 5.10.0-custom');
});

test('device-info: Windows (win32) 에서 Windows <release> 형식으로 반환한다', () => {
  const result = detectOsVersion({
    platform: 'win32',
    osRelease: () => '10.0.19045'
  });
  assert.equal(result, 'Windows 10.0.19045');
});

test('device-info: 기타 미지원 플랫폼에서는 <type> <release> 형식으로 폴백한다', () => {
  const result = detectOsVersion({
    platform: 'freebsd' as any,
    osType: () => 'FreeBSD',
    osRelease: () => '13.2-RELEASE'
  });
  assert.equal(result, 'FreeBSD 13.2-RELEASE');
});

// 실제 sw_vers 를 읽는 검사라 macOS 에서만 의미가 있다. CI(Linux runner)에서는 건너뛴다.
test('device-info: 실제 시스템에서 deviceInfo() 호출 시 platform 은 기계용 토큰, osVersion 은 macOS 제품 버전을 반환한다', { skip: process.platform !== 'darwin' }, () => {
  resetCachedOsVersionForTesting();
  const info = deviceInfo();

  // macOS 환경에서 실행되므로 platform 은 'macos'
  assert.equal(info.platform, 'macos');
  // 커널 버전('Darwin 25.5.0')이 아니라 제품 버전('macOS 26.5.2' 등)으로 시작해야 함
  assert.ok(info.osVersion.startsWith('macOS '), `osVersion(${info.osVersion})은 'macOS '로 시작해야 함`);
  assert.ok(!info.osVersion.startsWith('Darwin'), `osVersion(${info.osVersion})에 커널 이름 'Darwin'이 남아있으면 안 됨`);
  assert.ok(info.hostname.length > 0);
  assert.ok(info.appVersion.length > 0);
});

test('device-info: getCachedOsVersion 은 값을 캐싱하고 resetCachedOsVersionForTesting 으로 초기화할 수 있다', () => {
  resetCachedOsVersionForTesting();
  const v1 = getCachedOsVersion();
  const v2 = getCachedOsVersion();
  assert.equal(v1, v2);

  resetCachedOsVersionForTesting();
  const v3 = getCachedOsVersion();
  assert.equal(v1, v3);
});
