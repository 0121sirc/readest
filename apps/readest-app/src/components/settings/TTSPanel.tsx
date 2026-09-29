import React, { useCallback, useEffect, useState } from 'react';
import { PiSpinner } from 'react-icons/pi';
import { useEnv } from '@/context/EnvContext';
import { useReaderStore } from '@/store/readerStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useResetViewSettings } from '@/hooks/useResetSettings';
import { useTranslation } from '@/hooks/useTranslation';
import { saveViewSettings } from '@/helpers/settings';
import { getLocale } from '@/utils/misc';
import { eventDispatcher } from '@/utils/event';
import { getAPIBaseUrl } from '@/services/environment';
import { SettingsPanelPanelProp } from './SettingsDialog';
import {
  TTSHighlightGranularity,
  TTSMediaMetadataMode,
  TTSPlayerStyle,
} from '@/services/tts/types';
import { getTTSCacheConfig, setTTSCacheConfig } from '@/services/tts/providers/bookCacheStore';
import {
  getOpenAITTSConfig,
  OPENAI_TTS_MAX_LOOKAHEAD,
  OPENAI_TTS_MIN_LOOKAHEAD,
  OpenAITTSConfig,
  parseOpenAIVoices,
  setOpenAITTSConfig,
} from '@/services/tts/providers/openaiConfig';
import {
  BoxedList,
  SettingLabel,
  SettingsRow,
  SettingsSelect,
  SettingsSwitchRow,
} from './primitives';
import TTSHighlightStyleEditor, { TTSHighlightStyle } from './theme/TTSHighlightStyleEditor';

const TTSPanel: React.FC<SettingsPanelPanelProp> = ({ bookKey, onRegisterReset }) => {
  const _ = useTranslation();
  const { envConfig } = useEnv();
  const { getViewSettings } = useReaderStore();
  const { settings, setSettings, saveSettings } = useSettingsStore();
  const viewSettings = getViewSettings(bookKey) || settings.globalViewSettings;
  const isJapaneseUI = getLocale().toLowerCase().split('-')[0] === 'ja';

  const [ttsMediaMetadata, setTtsMediaMetadata] = useState<TTSMediaMetadataMode>(
    viewSettings.ttsMediaMetadata ?? 'sentence',
  );
  const [ttsPlayerStyle, setTtsPlayerStyle] = useState<TTSPlayerStyle>(
    viewSettings.ttsPlayerStyle ?? 'full',
  );
  const [ttsHighlightGranularity, setTtsHighlightGranularity] = useState<TTSHighlightGranularity>(
    viewSettings.ttsHighlightGranularity ?? 'word',
  );
  const [ttsSkipInlineAnnotations, setTtsSkipInlineAnnotations] = useState(
    viewSettings.ttsSkipInlineAnnotations ?? false,
  );
  const [ttsHighlightStyle, setTtsHighlightStyle] = useState(
    viewSettings.ttsHighlightOptions.style,
  );
  const [ttsHighlightColor, setTtsHighlightColor] = useState(
    viewSettings.ttsHighlightOptions.color,
  );
  const [customTtsHighlightColors, setCustomTtsHighlightColors] = useState(
    settings.globalReadSettings.customTtsHighlightColors || [],
  );

  const [ttsCacheConfig, setTtsCacheConfigState] = useState(getTTSCacheConfig());
  const [openaiTTSConfig, setOpenaiTTSConfigState] = useState<OpenAITTSConfig>(
    getOpenAITTSConfig(),
  );
  const [openaiTesting, setOpenaiTesting] = useState(false);

  const updateTTSCacheConfig = (config: typeof ttsCacheConfig) => {
    setTtsCacheConfigState(config);
    setTTSCacheConfig(config);
  };

  const updateOpenAITTSConfig = (patch: Partial<OpenAITTSConfig>) => {
    const next = { ...openaiTTSConfig, ...patch };
    setOpenaiTTSConfigState(next);
    setOpenAITTSConfig(next);
  };

  // Base for the voice-name discovery hint; literal placeholder until the user
  // fills a Base URL.
  const voiceBase = openaiTTSConfig.baseUrl.trim().replace(/\/+$/, '') || '<BASE_URL>';

  const showToast = useCallback(
    (type: 'info' | 'error', message: string) => {
      eventDispatcher.dispatch('toast', { type, message });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Synthesize and play a short sample so the user can hear the configured
  // endpoint and voice before reading a book. The voice is the server's first
  // (the same one used by default); it is fetched if not cached yet.
  const testOpenAITTS = useCallback(async () => {
    if (!openaiTTSConfig.baseUrl.trim() || openaiTesting) return;
    setOpenaiTesting(true);
    try {
      let voice = parseOpenAIVoices(openaiTTSConfig.voices)[0] ?? '';
      if (!voice) {
        try {
          const vr = await fetch(`${getAPIBaseUrl()}/tts/openai/voices`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              baseUrl: openaiTTSConfig.baseUrl,
              apiKey: openaiTTSConfig.apiKey,
            }),
          });
          if (vr.ok) {
            const data = (await vr.json()) as { voices?: { id?: string }[] };
            voice = data.voices?.[0]?.id ?? '';
          }
        } catch {
          // Fall through with an empty voice; the server may apply its default.
        }
      }

      const res = await fetch(`${getAPIBaseUrl()}/tts/openai`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseUrl: openaiTTSConfig.baseUrl,
          apiKey: openaiTTSConfig.apiKey,
          model: openaiTTSConfig.model,
          input: 'Hello, this is a test of the text to speech engine.',
          voice,
          responseFormat: 'mp3',
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        showToast(
          'error',
          _('TTS test failed ({{status}})', { status: res.status }) +
            (detail ? `: ${detail.slice(0, 160)}` : ''),
        );
        return;
      }
      const buffer = await res.arrayBuffer();
      const url = URL.createObjectURL(new Blob([buffer], { type: 'audio/mpeg' }));
      const audio = new Audio(url);
      audio.onended = () => URL.revokeObjectURL(url);
      await audio.play().catch(() => {});
      showToast('info', _('TTS test succeeded'));
    } catch (error) {
      showToast(
        'error',
        `${_('TTS test failed')}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setOpenaiTesting(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openaiTTSConfig, openaiTesting]);

  const resetToDefaults = useResetViewSettings();

  const handleReset = () => {
    resetToDefaults({
      ttsMediaMetadata: setTtsMediaMetadata as React.Dispatch<React.SetStateAction<string>>,
      ttsPlayerStyle: setTtsPlayerStyle as React.Dispatch<React.SetStateAction<string>>,
      ttsHighlightGranularity: setTtsHighlightGranularity as React.Dispatch<
        React.SetStateAction<string>
      >,
      ttsSkipInlineAnnotations: setTtsSkipInlineAnnotations,
    });
  };

  useEffect(() => {
    onRegisterReset(handleReset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (ttsMediaMetadata === viewSettings.ttsMediaMetadata) return;
    saveViewSettings(envConfig, bookKey, 'ttsMediaMetadata', ttsMediaMetadata, false, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ttsMediaMetadata]);

  useEffect(() => {
    if (ttsPlayerStyle === viewSettings.ttsPlayerStyle) return;
    saveViewSettings(envConfig, bookKey, 'ttsPlayerStyle', ttsPlayerStyle, false, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ttsPlayerStyle]);

  useEffect(() => {
    if (ttsHighlightGranularity === viewSettings.ttsHighlightGranularity) return;
    saveViewSettings(
      envConfig,
      bookKey,
      'ttsHighlightGranularity',
      ttsHighlightGranularity,
      false,
      false,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ttsHighlightGranularity]);

  useEffect(() => {
    if (ttsSkipInlineAnnotations === viewSettings.ttsSkipInlineAnnotations) return;
    saveViewSettings(
      envConfig,
      bookKey,
      'ttsSkipInlineAnnotations',
      ttsSkipInlineAnnotations,
      false,
      false,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ttsSkipInlineAnnotations]);

  const handleTTSStyleChange = (style: TTSHighlightStyle) => {
    setTtsHighlightStyle(style);
    saveViewSettings(envConfig, bookKey, 'ttsHighlightOptions', {
      style,
      color: ttsHighlightColor,
    });
  };

  const handleTTSColorChange = (color: string) => {
    setTtsHighlightColor(color);
    saveViewSettings(envConfig, bookKey, 'ttsHighlightOptions', {
      style: ttsHighlightStyle,
      color,
    });
  };

  const handleCustomTtsColorsChange = (colors: string[]) => {
    setCustomTtsHighlightColors(colors);
    settings.globalReadSettings.customTtsHighlightColors = colors;
    setSettings(settings);
    saveSettings(envConfig, settings);
  };

  const handleMediaMetadataChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    setTtsMediaMetadata(event.target.value as TTSMediaMetadataMode);
  };

  const handlePlayerStyleChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    setTtsPlayerStyle(event.target.value as TTSPlayerStyle);
  };

  const handleTTSGranularityChange = (granularity: TTSHighlightGranularity) => {
    setTtsHighlightGranularity(granularity);
  };

  return (
    <div className='my-4 w-full space-y-6'>
      <TTSHighlightStyleEditor
        granularity={ttsHighlightGranularity}
        style={ttsHighlightStyle}
        color={ttsHighlightColor}
        customColors={customTtsHighlightColors}
        onGranularityChange={handleTTSGranularityChange}
        onStyleChange={handleTTSStyleChange}
        onColorChange={handleTTSColorChange}
        onCustomColorsChange={handleCustomTtsColorsChange}
        data-setting-id='settings.tts.ttsHighlightStyle'
      />

      {isJapaneseUI && (
        <BoxedList title={_('Speech')} data-setting-id='settings.tts.speech'>
          <SettingsSwitchRow
            label={_('Skip Parenthetical Readings')}
            description={_('Do not speak kana or Han readings shown after Han text')}
            checked={ttsSkipInlineAnnotations}
            onChange={() => setTtsSkipInlineAnnotations(!ttsSkipInlineAnnotations)}
            data-setting-id='settings.tts.skipInlineAnnotations'
          />
        </BoxedList>
      )}

      <BoxedList title={_('Media Info')} data-setting-id='settings.tts.mediaMetadata'>
        <SettingsRow label={_('Player Style')} data-setting-id='settings.tts.playerStyle'>
          <SettingsSelect
            value={ttsPlayerStyle}
            onChange={handlePlayerStyleChange}
            ariaLabel={_('Player Style')}
            options={[
              { value: 'full', label: _('Full') },
              { value: 'minimal', label: _('Minimal') },
            ]}
          />
        </SettingsRow>
        <SettingsRow label={_('Update Frequency')}>
          <SettingsSelect
            value={ttsMediaMetadata}
            onChange={handleMediaMetadataChange}
            ariaLabel={_('Update Frequency')}
            options={[
              { value: 'sentence', label: _('Every Sentence') },
              { value: 'paragraph', label: _('Every Paragraph') },
              { value: 'chapter', label: _('Every Chapter') },
            ]}
          />
        </SettingsRow>
      </BoxedList>

      <BoxedList title={_('Audio Cache')} data-setting-id='settings.tts.audioCache'>
        <SettingsSwitchRow
          label={_('Cache Synthesized Audio')}
          description={_('Reuse generated speech across sessions without refetching')}
          checked={ttsCacheConfig.enabled}
          onChange={() =>
            updateTTSCacheConfig({ ...ttsCacheConfig, enabled: !ttsCacheConfig.enabled })
          }
          data-setting-id='settings.tts.audioCacheEnabled'
        />
        <SettingsSwitchRow
          label={_('Sync Audio Cache')}
          description={_('Share section audio between your devices through your file sync service')}
          checked={ttsCacheConfig.syncEnabled}
          disabled={!ttsCacheConfig.enabled}
          onChange={() =>
            updateTTSCacheConfig({ ...ttsCacheConfig, syncEnabled: !ttsCacheConfig.syncEnabled })
          }
          data-setting-id='settings.tts.audioCacheSync'
        />
        <SettingsRow label={_('Storage Limit')}>
          <SettingsSelect
            value={String(ttsCacheConfig.budgetMB)}
            onChange={(event) =>
              updateTTSCacheConfig({
                ...ttsCacheConfig,
                budgetMB: Number(event.target.value),
              })
            }
            ariaLabel={_('Storage Limit')}
            disabled={!ttsCacheConfig.enabled}
            options={[
              { value: '50', label: '50 MB' },
              { value: '100', label: '100 MB' },
              { value: '200', label: '200 MB' },
              { value: '500', label: '500 MB' },
              { value: '1024', label: '1 GB' },
            ]}
          />
        </SettingsRow>
      </BoxedList>

      <BoxedList title={_('Custom OpenAI TTS')} data-setting-id='settings.tts.openai'>
        {/* Base URL */}
        <div className='flex flex-col gap-2 py-3 pe-4'>
          <SettingLabel>{_('Base URL')}</SettingLabel>
          <input
            type='url'
            className='input input-sm bg-base-100 text-base-content w-full'
            value={openaiTTSConfig.baseUrl}
            placeholder='https://api.openai.com/v1'
            onChange={(event) => updateOpenAITTSConfig({ baseUrl: event.target.value })}
          />
        </div>

        {/* API key */}
        <div className='flex flex-col gap-2 py-3 pe-4'>
          <SettingLabel>{_('API Key')}</SettingLabel>
          <input
            type='password'
            autoComplete='off'
            className='input input-sm bg-base-100 text-base-content w-full'
            value={openaiTTSConfig.apiKey}
            placeholder={_('Optional')}
            onChange={(event) => updateOpenAITTSConfig({ apiKey: event.target.value })}
          />
        </div>

        {/* Model */}
        <div className='flex flex-col gap-2 py-3 pe-4'>
          <SettingLabel>{_('Model')}</SettingLabel>
          <input
            type='text'
            className='input input-sm bg-base-100 text-base-content w-full'
            value={openaiTTSConfig.model}
            placeholder={_('Optional')}
            onChange={(event) => updateOpenAITTSConfig({ model: event.target.value })}
          />
        </div>

        {/* Voice */}
        <div className='flex flex-col gap-2 py-3 pe-4'>
          <div className='flex w-full items-center justify-between'>
            <SettingLabel>{_('Voice')}</SettingLabel>
            <button
              type='button'
              className='btn btn-xs btn-contrast eink-bordered inline-flex items-center gap-1'
              onClick={testOpenAITTS}
              disabled={openaiTesting || !openaiTTSConfig.baseUrl.trim()}
            >
              {openaiTesting && <PiSpinner className='size-3.5 animate-spin' />}
              {_('Test')}
            </button>
          </div>
          <input
            type='text'
            className='input input-sm bg-base-100 text-base-content w-full'
            value={openaiTTSConfig.voices}
            placeholder='default'
            onChange={(event) => updateOpenAITTSConfig({ voices: event.target.value })}
          />
          <p className='text-base-content/60 text-xs break-words'>
            {`语音名称请访问 ${voiceBase}/voices?language=zh-CN 或 ${voiceBase}/voices 获取`}
          </p>
        </div>

        {/* Pre-synthesis look-ahead */}
        <SettingsRow
          label={_('Pre-synthesis Look-ahead')}
          description={_(
            'Sentences synthesized ahead of playback; higher is smoother on slow servers',
          )}
        >
          <SettingsSelect
            value={String(openaiTTSConfig.lookahead)}
            onChange={(event) => updateOpenAITTSConfig({ lookahead: Number(event.target.value) })}
            ariaLabel={_('Pre-synthesis Look-ahead')}
            options={Array.from(
              { length: OPENAI_TTS_MAX_LOOKAHEAD - OPENAI_TTS_MIN_LOOKAHEAD + 1 },
              (_, i) => {
                const value = OPENAI_TTS_MIN_LOOKAHEAD + i;
                return { value: String(value), label: String(value) };
              },
            )}
          />
        </SettingsRow>
      </BoxedList>
    </div>
  );
};

export default TTSPanel;
