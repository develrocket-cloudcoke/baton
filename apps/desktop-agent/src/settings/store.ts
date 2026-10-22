import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SETTINGS_SCHEMA, SettingsMap } from '../ipc/messages';
import { batonHome, readTextIfExists, writePrivateFile } from '../util/fs';

// 셸 없이 단독 실행할 때의 설정·토큰 저장소 (D3: 파일 0600).
//   ~/.baton/config.json  설정 (비밀값 없음)
//   ~/.baton/device-token 디바이스 토큰
export class LocalSettingsStore {
  readonly configPath: string;
  readonly tokenPath: string;

  constructor(home = batonHome()) {
    this.configPath = path.join(home, 'config.json');
    this.tokenPath = path.join(home, 'device-token');
  }

  all(): SettingsMap {
    const raw = readTextIfExists(this.configPath);
    let stored: SettingsMap = {};
    if (raw) {
      try {
        stored = JSON.parse(raw) as SettingsMap;
      } catch {
        stored = {};
      }
    }
    const out: SettingsMap = {};
    for (const field of SETTINGS_SCHEMA) out[field.key] = stored[field.key] ?? field.default ?? null;
    for (const key of Object.keys(stored)) if (!(key in out)) out[key] = stored[key];
    if (!out.deviceName) out.deviceName = os.hostname();
    return out;
  }

  apply(patch: SettingsMap): SettingsMap {
    const current = this.all();
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === undefined) delete current[key];
      else current[key] = value;
    }
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
    fs.writeFileSync(this.configPath, JSON.stringify(current, null, 2) + '\n');
    return this.all();
  }

  getToken(): string | null {
    const raw = readTextIfExists(this.tokenPath);
    const token = raw?.trim();
    return token ? token : null;
  }

  setToken(token: string | null): void {
    if (token === null) {
      if (fs.existsSync(this.tokenPath)) fs.unlinkSync(this.tokenPath);
      return;
    }
    writePrivateFile(this.tokenPath, token + '\n');
  }
}
