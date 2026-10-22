// MVP는 서버 프로세스 하나를 사용한다. 여러 인스턴스로 확장할 때는 공유 연결 소유권이 필요하다.
//
// 연결을 끊는 이유는 세 가지이고 데몬이 해야 할 일이 서로 다르다.
// - `connection.replaced`: 다른 데몬이 같은 디바이스로 붙었다 → 이쪽은 종료해야 한다(중복 실행)
// - `connection.revoked` : 사람이 웹에서 이 디바이스를 해제했다 → 종료하면 안 된다.
//   토큰만 죽은 것이고, 사용자는 곧 새 코드로 다시 pairing 한다.
//   (2026-09-21: 해제를 replaced 로 보내는 바람에 데몬이 exit 17 로 죽고 셸이
//    재시작을 포기해, 다시 pairing 하려 하면 "daemon not running" 이 떴다.)
// - **서버 종료**: 제어 이벤트 없이 스트림만 끝낸다 → 데몬은 평소의 끊김으로 보고 백오프 재연결한다.
//   여기에 replaced 나 revoked 를 보내면 배포할 때마다 모든 데몬이 죽거나 pairing 대기로 빠진다.
type Connection = {
  notify: (reason: string, eventName: 'connection.replaced' | 'connection.revoked') => void;
  end: () => void;
};
const connections = new Map<string, Connection>();

export function closeDeviceConnection(
  deviceId: string,
  reason: string,
  eventName: 'connection.replaced' | 'connection.revoked' = 'connection.replaced',
) {
  connections.get(deviceId)?.notify(reason, eventName);
}

/**
 * 서버가 내려갈 때 열려 있는 SSE 를 전부 끊는다.
 *
 * `enableShutdownHooks()` 를 켜면 Nest 가 HTTP 서버를 닫으며 **열린 연결이 끝나기를
 * 기다린다.** SSE 는 스스로 끝나지 않으므로 그대로 두면 종료가 멈춘다 — 2026-09-22 에
 * 실제로 dev 서버가 "Waiting for graceful termination..." 에서 멈췄다.
 */
export function endAllDeviceConnections() {
  for (const [, connection] of [...connections]) connection.end();
  connections.clear();
}

export function claimDeviceConnection(deviceId: string, connection: Connection) {
  closeDeviceConnection(deviceId, '다른 데몬이 연결되어 이전 연결을 종료합니다.');
  connections.set(deviceId, connection);
  return () => {
    if (connections.get(deviceId) === connection) connections.delete(deviceId);
  };
}
