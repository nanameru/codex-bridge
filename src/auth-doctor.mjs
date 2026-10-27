/** Local-only, read-only credential diagnosis. No inference and no token output. */
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { codexRoot, diagnoseCodexAuth } from './local-security.mjs';

const HINTS = {
  unsafe_codex_home: 'CODEX_HOMEの所有者と書込み権限を確認してください。',
  credential_config_invalid: 'config.tomlの構文・権限とPython 3.11以上を確認してください。',
  unsupported_credential_store: 'file/keyring/autoに対応しています。メモリ限定の認証は別プロセスと共有できません。',
  keyring_platform_unsupported: 'Keychain読み取りはmacOSに対応しています。このOSのkeyringは未対応です。',
  keyring_unavailable: 'このCODEX_HOMEのKeychain項目が未登録か、読み取りが拒否されています。本人のCodexでログイン状態を確認してください。',
  auth_file_unavailable: '同じCODEX_HOMEのauth.jsonが必要です。本人所有・0600相当の通常ファイルか確認してください。',
  credential_expired: '本人のCodexで認証を更新し、Codexから接続し直してください。',
  credential_missing: '有効なaccess_tokenまたはAPIキーがありません。本人のCodexでログイン状態を確認してください。',
  credential_invalid: '認証データを解釈できません。認証データは共有せず、本人のCodexでログイン状態を確認してください。',
  credential_unavailable: 'CODEX_HOMEが存在するか、本人のユーザーで実行しているか確認してください。',
};

try {
  const { values } = parseArgs({ options: { root: { type: 'string' } }, allowPositionals: false });
  const root = resolve(values.root ?? codexRoot());
  const result = diagnoseCodexAuth(root);
  console.log(JSON.stringify({ ...result, codex_home: root,
    hint: result.ok ? '認証の読み取りは正常です。401が続く場合はCodexと両サービスのCODEX_HOME・起動ユーザーが同じか確認し、Codexを起動し直してください。' : HINTS[result.reason] }, null, 2));
  process.exitCode = result.ok ? 0 : 1;
} catch {
  console.error('使い方: node src/auth-doctor.mjs [--root CODEXの設定ディレクトリ]');
  process.exitCode = 2;
}
