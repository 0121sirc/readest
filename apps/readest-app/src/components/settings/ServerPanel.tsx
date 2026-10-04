import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { useSettingsStore } from '@/store/settingsStore';
import { useEnv } from '@/context/EnvContext';
import { DEFAULT_SERVER_SETTINGS } from '@/services/constants';
import type { ServerSettings } from '@/types/settings';
import { isReadestAccountHidden, isSelfHosted } from '@/utils/access';
import { BoxedList, SettingLabel, SettingsSwitchRow, Tips } from './primitives';

interface ServerFieldProps {
  label: string;
  value: string;
  placeholder: string;
  type?: 'text' | 'password';
  onChange: (value: string) => void;
}

const ServerField: React.FC<ServerFieldProps> = ({
  label,
  value,
  placeholder,
  type = 'text',
  onChange,
}) => (
  <div className='flex flex-col gap-2 py-3 pe-4'>
    <SettingLabel>{label}</SettingLabel>
    <input
      type={type}
      className='input input-sm w-full'
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      autoComplete='off'
      spellCheck={false}
    />
  </div>
);

/**
 * Server endpoints + deployment flags. The web build injects these through
 * `window.__READEST_RUNTIME_CONFIG`; the desktop build is a static export with
 * no such injection, so a user can point it at their own deployment here
 * without a rebuild. Blank values fall through to the runtime config and the
 * baked `NEXT_PUBLIC_*` defaults.
 */
const ServerPanel: React.FC = () => {
  const _ = useTranslation();
  const { envConfig } = useEnv();
  const { settings, setSettings, saveSettings } = useSettingsStore();

  const server: ServerSettings = settings?.server ?? DEFAULT_SERVER_SETTINGS;
  const [selfHosted, setSelfHosted] = useState(isSelfHosted());
  const [accountHidden, setAccountHidden] = useState(isReadestAccountHidden());

  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const update = useCallback(
    async (key: keyof ServerSettings, value: string | boolean) => {
      const current = settingsRef.current;
      if (!current) return;
      const nextServer: ServerSettings = {
        ...(current.server ?? DEFAULT_SERVER_SETTINGS),
        [key]: value,
      };
      const nextSettings = { ...current, server: nextServer };
      setSettings(nextSettings);
      await saveSettings(envConfig, nextSettings);
    },
    [envConfig, setSettings, saveSettings],
  );

  return (
    <div className='my-4 w-full space-y-6'>
      <BoxedList
        title={_('Server')}
        description={_(
          'Point Readest at your own deployment for translation, AI, metadata, sync and other server-backed features. Leave blank to use the built-in defaults.',
        )}
      >
        <ServerField
          label={_('Web API Base URL')}
          value={server.apiBaseUrl}
          placeholder='https://web.readest.com'
          onChange={(value) => update('apiBaseUrl', value)}
        />
        <ServerField
          label={_('Node API Base URL')}
          value={server.nodeApiBaseUrl}
          placeholder='https://node.readest.com'
          onChange={(value) => update('nodeApiBaseUrl', value)}
        />
      </BoxedList>

      <BoxedList
        title={_('Account')}
        description={_(
          'Only needed when the account and Readest Cloud surface is enabled. Ignored in local-first mode.',
        )}
      >
        <ServerField
          label={_('Supabase URL')}
          value={server.supabaseUrl}
          placeholder='https://your-project.supabase.co'
          onChange={(value) => update('supabaseUrl', value)}
        />
        <ServerField
          label={_('Supabase Anon Key')}
          value={server.supabaseAnonKey}
          placeholder='eyJ...'
          type='password'
          onChange={(value) => update('supabaseAnonKey', value)}
        />
        <SettingsSwitchRow
          label={_('Self-hosted deployment')}
          checked={selfHosted}
          onChange={() => {
            const next = !selfHosted;
            setSelfHosted(next);
            update('selfHosted', next);
          }}
        />
        <SettingsSwitchRow
          label={_('Hide Readest account')}
          checked={accountHidden}
          onChange={() => {
            const next = !accountHidden;
            setAccountHidden(next);
            update('disableReadestAccount', next);
          }}
        />
      </BoxedList>

      <Tips>
        <li>
          {_(
            'Translations from Google and MyMemory, and your WebDAV / S3 / KOSync servers, are configured elsewhere and do not depend on these endpoints.',
          )}
        </li>
        <li>{_('Changing the account endpoints takes effect after restarting the app.')}</li>
      </Tips>
    </div>
  );
};

export default ServerPanel;
