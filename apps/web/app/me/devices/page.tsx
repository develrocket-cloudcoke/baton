'use client';

import React, { useState, useEffect } from 'react';
import { copyText } from '@/lib/clipboard';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/components/auth-provider';
import { apiClient } from '@/lib/api-client';
import { DeviceInfo, PairingCodeResponse } from '@/lib/types';
import { ConfirmModal } from '@/components/ui/modal';
import {
  Laptop,
  Plus,
  Trash2,
  Clock,
  CheckCircle,
  Copy,
  RefreshCw,
  QrCode,
  ShieldCheck,
} from 'lucide-react';

// mock 모드에서만 쓰는 스크린샷용 가짜 pairing 코드 (real 모드에서는 서버가 발급한 코드만 보여 준다)
const DEMO_PAIRING_ALLOWED = process.env.NEXT_PUBLIC_API_MODE === 'mock';
const DEMO_PAIRING_DATA = (): PairingCodeResponse => ({
  code: '7K9X-M2P4',
  expiresAt: new Date(Date.now() + 600 * 1000).toISOString(),
});

// 데몬이 보내는 platform 값(04 §11.4: macos/windows/linux, 구버전은 Node process.platform)
function platformLabel(platform?: string): string {
  switch ((platform || '').toLowerCase()) {
    case 'macos':
    case 'darwin':
      return 'macOS';
    case 'windows':
    case 'win32':
      return 'Windows';
    case 'linux':
      return 'Linux';
    default:
      return platform || '-';
  }
}

export default function MyDevicesPage() {
  const { currentUser } = useAuth();
  const queryClient = useQueryClient();

  const [isModalOpen, setIsModalOpen] = useState<boolean>(() => {
    if (typeof window !== 'undefined' && DEMO_PAIRING_ALLOWED) {
      return new URLSearchParams(window.location.search).get('modal') === 'pairing';
    }
    return false;
  });
  const [pairingData, setPairingData] = useState<PairingCodeResponse | null>(() => {
    // `?modal=pairing` 은 스크린샷용 데모 훅이다. real 모드에서 가짜 코드를 보여 주면
    // 사용자가 그대로 입력해 "유효하지 않은 pairing 코드" 를 만나므로 mock 모드에서만 채운다.
    if (typeof window !== 'undefined' && DEMO_PAIRING_ALLOWED) {
      if (new URLSearchParams(window.location.search).get('modal') === 'pairing') {
        return DEMO_PAIRING_DATA();
      }
    }
    return null;
  });
  const [timeLeftSeconds, setTimeLeftSeconds] = useState<number>(595);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  // 연결 해제 확인 모달 상태 (window.confirm 대체)
  const [deviceToDisconnect, setDeviceToDisconnect] = useState<DeviceInfo | null>(null);

  // 디바이스 목록 조회
  const { data: devices = [], isLoading } = useQuery<DeviceInfo[]>({
    queryKey: ['my-devices', currentUser.id],
    queryFn: () => apiClient.getDevices(currentUser.id),
    // pairing 은 상대 컴퓨터에서 일어난다. 모달이 열려 있는 동안 목록을 다시 읽어
    // 연결되는 순간을 이 화면에서 바로 보여 준다 (예전에는 닫아도 목록이 그대로라
    // 실패한 것처럼 보였다).
    refetchInterval: isModalOpen ? 3000 : false,
  });

  // 모달을 연 시점의 디바이스 수. 이보다 늘면 이번 코드로 연결된 것이다.
  const [devicesAtOpen, setDevicesAtOpen] = useState<number | null>(null);
  const justPaired = devicesAtOpen !== null && devices.length > devicesAtOpen;

  const closePairingModal = () => {
    setIsModalOpen(false);
    setDevicesAtOpen(null);
    // 폴링을 멈추기 전에 한 번 더 읽는다 — 닫는 순간 연결됐을 수도 있다.
    queryClient.invalidateQueries({ queryKey: ['my-devices', currentUser.id] });
  };

  // URL 쿼리 파라미터(?modal=disconnect) 연동
  useEffect(() => {
    if (typeof window !== 'undefined' && devices.length > 0) {
      if (new URLSearchParams(window.location.search).get('modal') === 'disconnect') {
        setDeviceToDisconnect(devices[0]);
      }
    }
  }, [devices]);

  // 페어링 코드 생성 뮤테이션
  const createPairingCodeMutation = useMutation({
    mutationFn: () => apiClient.createPairingCode(currentUser.id),
    onSuccess: (data) => {
      setPairingData(data);
      const expires = new Date(data.expiresAt).getTime();
      const diff = Math.max(0, Math.floor((expires - Date.now()) / 1000));
      setTimeLeftSeconds(diff > 0 ? diff : 600);
      setDevicesAtOpen(devices.length);
      setIsModalOpen(true);
    },
    onError: (err: Error) => {
      setMessage({ type: 'error', text: err.message });
    },
  });

  // 디바이스 연결 해제 뮤테이션
  const deleteDeviceMutation = useMutation({
    mutationFn: (deviceId: string) => apiClient.deleteDevice(deviceId, currentUser.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['my-devices', currentUser.id] });
      setMessage({ type: 'success', text: '디바이스 연결이 해제되었습니다.' });
      setTimeout(() => setMessage(null), 3000);
    },
    onError: (err: Error) => {
      setMessage({ type: 'error', text: err.message });
    },
  });

  // URL 쿼리 기반 모달 트리거 (스크린샷 및 데모 지원)
  useEffect(() => {
    if (typeof window !== 'undefined' && DEMO_PAIRING_ALLOWED) {
      const params = new URLSearchParams(window.location.search);
      if (params.get('modal') === 'pairing') {
        setPairingData(DEMO_PAIRING_DATA());
        setTimeLeftSeconds(595);
        setIsModalOpen(true);
      }
    }
  }, []);

  // 카운트다운 타이머
  useEffect(() => {
    if (!isModalOpen || timeLeftSeconds <= 0) return;
    const interval = setInterval(() => {
      setTimeLeftSeconds((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(interval);
  }, [isModalOpen, timeLeftSeconds]);

  const formatTimer = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  };

  const handleCopy = async (code: string) => {
    // http(사내망 주소)로 열면 Clipboard API 가 아예 없다 — copyText 가 대체 경로를 쓴다.
    const ok = await copyText(code);
    setCopyState(ok ? 'copied' : 'failed');
    setTimeout(() => setCopyState('idle'), 2500);
  };

  return (
    <div className="mx-auto max-w-5xl py-8 px-4 sm:px-6 lg:px-8">
      {/* 헤더 */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between pb-6 border-b border-slate-200">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold text-slate-900">내 디바이스 관리</h1>
            <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-700">
              {currentUser.displayName}
            </span>
          </div>
          <p className="mt-1 text-sm text-slate-600">
            Baton에 연결된 개인 작업용 기기 목록을 확인하고 관리합니다.
          </p>
        </div>
        <div className="mt-4 sm:mt-0">
          <button
            onClick={() => createPairingCodeMutation.mutate()}
            disabled={createPairingCodeMutation.isPending}
            className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:opacity-50 transition"
          >
            <Plus className="w-4 h-4" />
            <span>디바이스 추가</span>
          </button>
        </div>
      </div>

      {message && (
        <div
          className={`mt-4 rounded-lg p-3 text-sm flex items-center gap-2 ${
            message.type === 'success'
              ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
              : 'bg-red-50 text-red-800 border border-red-200'
          }`}
        >
          <CheckCircle className="w-4 h-4 shrink-0" />
          <span>{message.text}</span>
        </div>
      )}

      {/* 디바이스 목록 */}
      <div className="mt-8 space-y-4">
        <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
          <Laptop className="w-5 h-5 text-slate-600" />
          연결된 디바이스 ({devices.length}대)
        </h2>

        {isLoading ? (
          <div className="py-12 text-center text-slate-500 text-sm">디바이스 로딩 중...</div>
        ) : devices.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center bg-white">
            <Laptop className="mx-auto h-12 w-12 text-slate-300 mb-3" />
            <h3 className="text-sm font-bold text-slate-900">등록된 디바이스가 없습니다</h3>
            <p className="mt-1 text-xs text-slate-500 max-w-sm mx-auto">
              우측 상단의 [디바이스 추가] 버튼을 눌러 데스크톱 에이전트 앱(Baton Menu Bar)에 페어링
              코드를 입력하세요.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {devices.map((device) => {
              // 접속 기록이 없거나 status가 OFFLINE인 경우 OFFLINE으로 표시
              const isOffline = !device.lastSeenAt || device.status === 'OFFLINE';
              const displayStatus = isOffline ? 'OFFLINE' : device.status || 'ONLINE';
              const platform = platformLabel(device.platform);

              return (
                <div
                  key={device.id}
                  className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm flex flex-col justify-between"
                >
                  <div>
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-50 text-indigo-700">
                          <Laptop className="h-5 w-5" />
                        </div>
                        <div>
                          <h3 className="font-bold text-slate-900 text-sm">{device.name}</h3>
                          <p className="text-xs text-slate-500 font-mono mt-0.5">
                            {device.hostname || platform}
                          </p>
                        </div>
                      </div>
                      <span
                        className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold shrink-0 ${
                          displayStatus === 'ONLINE'
                            ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                            : 'bg-slate-100 text-slate-600 border border-slate-200'
                        }`}
                      >
                        <span
                          className={`w-1.5 h-1.5 rounded-full ${
                            displayStatus === 'ONLINE'
                              ? 'bg-emerald-500 animate-pulse'
                              : 'bg-slate-400'
                          }`}
                        />
                        {displayStatus}
                      </span>
                    </div>

                    <div className="mt-4 pt-3 border-t border-slate-100 space-y-2 text-xs text-slate-600">
                      <div className="flex justify-between">
                        <span className="text-slate-400">플랫폼:</span>
                        <span className="font-mono text-slate-700">{platform}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-400">운영체제(OS):</span>
                        <span className="font-mono text-slate-700">{device.osVersion || '-'}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-400">앱 버전:</span>
                        <span className="font-mono text-slate-700">{device.appVersion || '-'}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-400">호스트명:</span>
                        <span className="font-mono text-slate-700 truncate max-w-[180px]">
                          {device.hostname || device.deviceFingerprint || '-'}
                        </span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-slate-400">마지막 접속:</span>
                        <span>
                          {device.lastSeenAt ? (
                            <span className="text-slate-700 font-medium">
                              {new Date(device.lastSeenAt).toLocaleString('ko-KR')}
                            </span>
                          ) : (
                            <span className="text-amber-600 bg-amber-50 px-2 py-0.5 rounded border border-amber-200 text-[11px] font-semibold">
                              접속 기록 없음
                            </span>
                          )}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="mt-5 pt-3 border-t border-slate-100 flex justify-end">
                    <button
                      onClick={() => setDeviceToDisconnect(device)}
                      disabled={deleteDeviceMutation.isPending}
                      className="flex items-center gap-1 text-xs text-red-600 hover:text-red-700 font-medium px-2 py-1 rounded hover:bg-red-50 transition"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>연결 해제</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 페어링 코드 모달 */}
      {isModalOpen && pairingData && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl border border-slate-200 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-indigo-50 text-indigo-600 mb-4">
              <QrCode className="h-6 w-6" />
            </div>

            <h3 className="text-lg font-bold text-slate-900">새 디바이스 페어링</h3>
            <p className="mt-1 text-xs text-slate-600">
              Mac/데스크톱 메뉴바 앱의 [기기 등록] 화면에 아래의 8자리 코드를 입력해주세요.
            </p>

            {/* 페어링 코드 대형 표시 */}
            <div className="my-6 rounded-xl bg-slate-50 border border-slate-200 p-5">
              <span className="text-xs text-slate-500 font-medium uppercase tracking-wider block mb-1">
                8자리 페어링 코드
              </span>
              {/* 복사가 막힐 수 있으므로 코드 자체를 선택할 수 있게 둔다 (드래그 → Cmd+C) */}
              <div className="select-all text-3xl font-black font-mono tracking-widest text-indigo-600">
                {pairingData.code}
              </div>
              <div className="mt-3 flex justify-center">
                <button
                  onClick={() => void handleCopy(pairingData.code)}
                  className="flex items-center gap-1.5 rounded-md bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 border border-slate-300 shadow-sm hover:bg-slate-50 transition"
                >
                  <Copy className="w-3.5 h-3.5" />
                  <span>{copyState === 'copied' ? '복사되었습니다!' : copyState === 'failed' ? '복사 실패 — 코드를 직접 선택해 주세요' : '코드 복사'}</span>
                </button>
              </div>
            </div>

            {/* 카운트다운 타이머 */}
            <div className="flex items-center justify-center gap-2 text-xs font-semibold text-slate-600 mb-6">
              <Clock className="w-4 h-4 text-amber-500" />
              <span>
                남은 유효시간:{' '}
                <span
                  className={timeLeftSeconds < 60 ? 'text-red-600 font-bold' : 'text-slate-900'}
                >
                  {formatTimer(timeLeftSeconds)}
                </span>
              </span>
            </div>

            {justPaired && (
              <div
                data-testid="pairing-connected"
                className="mb-4 rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-center text-xs font-semibold text-emerald-900"
              >
                새 디바이스가 연결되었습니다. 닫으면 목록에 나타납니다.
              </div>
            )}

            <div className="flex gap-3 justify-center">
              <button
                type="button"
                onClick={() => createPairingCodeMutation.mutate()}
                disabled={createPairingCodeMutation.isPending}
                className="flex items-center gap-1 rounded-lg border border-slate-300 px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 transition"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>코드 재발급</span>
              </button>
              <button
                type="button"
                onClick={closePairingModal}
                className="rounded-lg bg-indigo-600 px-6 py-2 text-xs font-semibold text-white hover:bg-indigo-700 transition"
              >
                {justPaired ? '완료' : '닫기'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 디바이스 연결 해제 확인 모달 (window.confirm 대체) */}
      <ConfirmModal
        isOpen={Boolean(deviceToDisconnect)}
        onClose={() => setDeviceToDisconnect(null)}
        onConfirm={() => {
          if (deviceToDisconnect) {
            deleteDeviceMutation.mutate(deviceToDisconnect.id);
            setDeviceToDisconnect(null);
          }
        }}
        title="디바이스 연결 해제"
        description={
          <span>
            <strong className="font-bold text-slate-800">'{deviceToDisconnect?.name}'</strong>{' '}
            디바이스 연결을 해제하시겠습니까?
          </span>
        }
        warningText="연결이 해제되면 해당 디바이스에서 실행 대기 중인 에이전트 프로세스와의 통신이 중단됩니다."
        confirmLabel="연결 해제"
        cancelLabel="취소"
        variant="danger"
        isLoading={deleteDeviceMutation.isPending}
      />
    </div>
  );
}
