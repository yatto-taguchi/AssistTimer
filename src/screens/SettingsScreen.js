import React, { useContext, useState, useEffect, useRef } from 'react';
import { 
  StyleSheet, Text, View, Switch, TouchableOpacity, Modal, 
  TextInput, KeyboardAvoidingView, Platform, ScrollView,
  LayoutAnimation, UIManager, Vibration, Linking 
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Audio } from 'expo-av';
import { AppContext } from '../utils/AppContext';
import ProSubscriptionModal from '../components/ProSubscriptionModal';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const ALARM_SOUNDS = {
  kitchen: require('../../assets/alarm_kitchen.wav'),
  fast: require('../../assets/alarm_fast.wav'),
  digital: require('../../assets/alarm_digital.wav'),
  buzzer: require('../../assets/alarm_buzzer.wav'),
  bell: require('../../assets/alarm_bell.wav'),
  gong: require('../../assets/alarm_gong.wav'),
};

const ALARM_SOUND_OPTIONS = [
  { key: 'kitchen', label: 'キッチンタイマー', desc: 'ピッピッピッピッ！' },
  { key: 'fast', label: '高速アラーム', desc: 'ピピピピピピ！' },
  { key: 'digital', label: 'デジタル電子音', desc: 'ピピピピ' },
  { key: 'buzzer', label: '競技ブザー', desc: 'ブーッ！' },
  { key: 'bell', label: 'ベル・チャイム', desc: 'ポーン…' },
  { key: 'gong', label: 'クリアゴング', desc: 'キーン…' },
  { key: 'none', label: '無音（なし）', desc: 'アラーム音を鳴らさない' },
];

const VOICE_SAMPLES = {
  // タイマー計測中用
  v_5min: require('../../assets/voice_5min.wav'),
  v_3min: require('../../assets/voice_3min.wav'),
  v_1min: require('../../assets/voice_1min.wav'),
  v_30sec: require('../../assets/voice_30sec.wav'),
  v_10sec: require('../../assets/voice_10sec.wav'),
  v_finish: require('../../assets/voice_finish.wav'),
  // スタート事前準備時間用
  p_15min: require('../../assets/voice_prep_15min.wav'),
  p_10min: require('../../assets/voice_prep_10min.wav'),
  p_5min: require('../../assets/voice_prep_5min.wav'),
  p_4min: require('../../assets/voice_prep_4min.wav'),
  p_3min: require('../../assets/voice_prep_3min.wav'),
  p_2min: require('../../assets/voice_prep_2min.wav'),
  p_1min: require('../../assets/voice_prep_1min.wav'),
  p_30sec: require('../../assets/voice_prep_30sec.wav'),
  p_10sec: require('../../assets/voice_prep_10sec.wav'),
  p_countdown: require('../../assets/voice_prep_countdown_5.wav'),
  // カウントアップ・超過時間用
  o_start: require('../../assets/voice_over_start.wav'),
  o_1min: require('../../assets/voice_over_1min.wav'),
  o_3min: require('../../assets/voice_over_3min.wav'),
  o_5min: require('../../assets/voice_over_5min.wav'),
  o_10min: require('../../assets/voice_over_10min.wav'),
  o_15min: require('../../assets/voice_over_15min.wav'),
};

export default function SettingsScreen({ route }) {
  const { 
    isEcoMode, toggleEcoMode, 
    isEcoClockEnabled, toggleEcoClock,
    isEcoBatteryEnabled, toggleEcoBattery,
    isEcoNavIconEnabled, toggleEcoNavIcon,
    isEcoNavActiveDot, toggleEcoNavActiveDot,
    isEcoBorderEnabled, toggleEcoBorder,
    isEcoIndicatorEnabled, toggleEcoIndicator,
    isNormalStatusBarEnabled, toggleNormalStatusBar,
    isNormalStatusBarAutoHide, toggleNormalStatusBarAutoHide,
    isNormalIndicatorEnabled, toggleNormalIndicator,
    isProMode, toggleProMode, 
    isColorIndicator, toggleColorIndicator,
    isCountdownEnabled, toggleCountdownEnabled,
    countdownSeconds, saveCountdownSeconds,
    alarmSoundType, toggleAlarmSoundType,
    playsInSilentMode, togglePlaysInSilentMode,
    isVibrationEnabled, toggleVibrationEnabled,
    isVibration3SecOnly, toggleVibration3SecOnly,
    vibrationIntensity, saveVibrationIntensity,
    isVibPrepEnabled, toggleVibPrep,
    isVibWarningEnabled, toggleVibWarning,
    isVibFinishEnabled, toggleVibFinish,
    isVibOvertimeEnabled, toggleVibOvertime,
    isVoice5MinEnabled, toggleVoice5Min,
    isVoice3MinEnabled, toggleVoice3Min,
    isVoice1MinEnabled, toggleVoice1Min,
    isVoice30SecEnabled, toggleVoice30Sec,
    isVoice10SecEnabled, toggleVoice10Sec,
    isVoiceFinishEnabled, toggleVoiceFinish,
    isPrepVoice15MinEnabled, togglePrepVoice15Min,
    isPrepVoice10MinEnabled, togglePrepVoice10Min,
    isPrepVoice5MinEnabled, togglePrepVoice5Min,
    isPrepVoice4MinEnabled, togglePrepVoice4Min,
    isPrepVoice3MinEnabled, togglePrepVoice3Min,
    isPrepVoice2MinEnabled, togglePrepVoice2Min,
    isPrepVoice1MinEnabled, togglePrepVoice1Min,
    isPrepVoice30SecEnabled, togglePrepVoice30Sec,
    isPrepVoice10SecEnabled, togglePrepVoice10Sec,
    isPrepVoiceCountdownEnabled, togglePrepVoiceCountdown,
    isOverVoiceStartEnabled, toggleOverVoiceStart,
    isOverVoice1MinEnabled, toggleOverVoice1Min,
    isOverVoice3MinEnabled, toggleOverVoice3Min,
    isOverVoice5MinEnabled, toggleOverVoice5Min,
    isOverVoice10MinEnabled, toggleOverVoice10Min,
    isOverVoice15MinEnabled, toggleOverVoice15Min,
    hasSeenEcoExplanation, markEcoExplanationSeen
  } = useContext(AppContext);

  const [ecoModalVisible, setEcoModalVisible] = useState(false);
  const [proModalVisible, setProModalVisible] = useState(false);
  const [previewSound, setPreviewSound] = useState(null);
  const [playingVoiceKey, setPlayingVoiceKey] = useState(null);
  const [isTestingVibration, setIsTestingVibration] = useState(false);
  const testVibrationTimeoutRef = useRef(null);

  const handleTestVibration = () => {
    if (isTestingVibration) {
      if (testVibrationTimeoutRef.current) clearTimeout(testVibrationTimeoutRef.current);
      Vibration.cancel();
      setIsTestingVibration(false);
      return;
    }
    setIsTestingVibration(true);
    let pattern;
    if (vibrationIntensity === 'strong') {
      pattern = [0, 800, 150, 800, 150, 800]; // 激しい強力パルス
    } else if (vibrationIntensity === 'gentle') {
      pattern = [0, 250, 250, 250, 250, 250]; // 控えめな短いパルス
    } else {
      pattern = [0, 500, 200, 500, 200, 500]; // 標準
    }
    Vibration.vibrate(pattern);
    testVibrationTimeoutRef.current = setTimeout(() => {
      Vibration.cancel();
      setIsTestingVibration(false);
    }, 3000);
  };

  useEffect(() => {
    return () => {
      if (testVibrationTimeoutRef.current) clearTimeout(testVibrationTimeoutRef.current);
      Vibration.cancel();
    };
  }, []);

  // アコーディオン開閉状態（初期値: すべて閉じてコンパクトに表示）
  const [isAlarmSoundOpen, setIsAlarmSoundOpen] = useState(false);
  const [isMainVoiceOpen, setIsMainVoiceOpen] = useState(false);
  const [isPrepVoiceOpen, setIsPrepVoiceOpen] = useState(false);
  const [isOverVoiceOpen, setIsOverVoiceOpen] = useState(false);
  const scrollViewRef = useRef(null);

  // タイマー画面のクイックアクセスバー長押しからの遷移時、該当アコーディオンを自動展開＆スクロール
  useEffect(() => {
    if (route?.params?.scrollTo) {
      const target = route.params.scrollTo;
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      if (target === 'alarm') {
        setIsAlarmSoundOpen(true);
        setTimeout(() => {
          scrollViewRef.current?.scrollTo({ y: 460, animated: true });
        }, 200);
      } else if (target === 'voice') {
        setIsMainVoiceOpen(true);
        setTimeout(() => {
          scrollViewRef.current?.scrollTo({ y: 550, animated: true });
        }, 200);
      } else if (target === 'overtime') {
        setIsOverVoiceOpen(true);
        setTimeout(() => {
          scrollViewRef.current?.scrollTo({ y: 640, animated: true });
        }, 200);
      }
    }
  }, [route?.params?.scrollTo]);

  const toggleAccordion = (setter) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setter(prev => !prev);
  };

  const MAIN_VOICE_OPTIONS = [
    { key: 'v_5min', label: '残り5分', phrase: '「残り、5分です」', isEnabled: isVoice5MinEnabled, toggle: toggleVoice5Min },
    { key: 'v_3min', label: '残り3分', phrase: '「残り、3分です」', isEnabled: isVoice3MinEnabled, toggle: toggleVoice3Min },
    { key: 'v_1min', label: '残り1分', phrase: '「残り、1分です」', isEnabled: isVoice1MinEnabled, toggle: toggleVoice1Min },
    { key: 'v_30sec', label: '残り30秒', phrase: '「残り、30秒です」', isEnabled: isVoice30SecEnabled, toggle: toggleVoice30Sec },
    { key: 'v_10sec', label: '残り10秒', phrase: '「残り、10秒」', isEnabled: isVoice10SecEnabled, toggle: toggleVoice10Sec },
    { key: 'v_finish', label: 'カウント終了', phrase: '「5,4,3,2,1 終了」', isEnabled: isVoiceFinishEnabled, toggle: toggleVoiceFinish },
  ];

  const PREP_VOICE_OPTIONS = [
    { key: 'p_15min', label: '15分前', phrase: '「15分前」（開始時:「計測開始、15分前」）', isEnabled: isPrepVoice15MinEnabled, toggle: togglePrepVoice15Min },
    { key: 'p_10min', label: '10分前', phrase: '「10分前」（開始時:「計測開始、10分前」）', isEnabled: isPrepVoice10MinEnabled, toggle: togglePrepVoice10Min },
    { key: 'p_5min', label: '5分前', phrase: '「5分前」（開始時:「計測開始、5分前」）', isEnabled: isPrepVoice5MinEnabled, toggle: togglePrepVoice5Min },
    { key: 'p_4min', label: '4分前', phrase: '「4分前」', isEnabled: isPrepVoice4MinEnabled, toggle: togglePrepVoice4Min },
    { key: 'p_3min', label: '3分前', phrase: '「3分前」（開始時:「計測開始、3分前」）', isEnabled: isPrepVoice3MinEnabled, toggle: togglePrepVoice3Min },
    { key: 'p_2min', label: '2分前', phrase: '「2分前」', isEnabled: isPrepVoice2MinEnabled, toggle: togglePrepVoice2Min },
    { key: 'p_1min', label: '1分前', phrase: '「1分前」（開始時:「計測開始、1分前」）', isEnabled: isPrepVoice1MinEnabled, toggle: togglePrepVoice1Min },
    { key: 'p_30sec', label: '30秒前', phrase: '「30秒前」（開始時:「計測開始、30秒前」）', isEnabled: isPrepVoice30SecEnabled, toggle: togglePrepVoice30Sec },
    { key: 'p_10sec', label: '10秒前', phrase: '「10秒前」（開始時:「計測開始、10秒前」）', isEnabled: isPrepVoice10SecEnabled, toggle: togglePrepVoice10Sec },
    { key: 'p_countdown', label: '直前カウント', phrase: '「5、4、3、2、1、スタート！」', isEnabled: isPrepVoiceCountdownEnabled, toggle: togglePrepVoiceCountdown },
  ];

  const OVER_VOICE_OPTIONS = [
    { key: 'o_start', label: 'カウントアップ開始', phrase: '「カウントアップを始めます」', isEnabled: isOverVoiceStartEnabled, toggle: toggleOverVoiceStart },
    { key: 'o_1min', label: '1分超過', phrase: '「1分超過」', isEnabled: isOverVoice1MinEnabled, toggle: toggleOverVoice1Min },
    { key: 'o_3min', label: '3分超過', phrase: '「3分超過」', isEnabled: isOverVoice3MinEnabled, toggle: toggleOverVoice3Min },
    { key: 'o_5min', label: '5分超過', phrase: '「5分超過」', isEnabled: isOverVoice5MinEnabled, toggle: toggleOverVoice5Min },
    { key: 'o_10min', label: '10分超過', phrase: '「10分超過」', isEnabled: isOverVoice10MinEnabled, toggle: toggleOverVoice10Min },
    { key: 'o_15min', label: '15分超過', phrase: '「15分超過」', isEnabled: isOverVoice15MinEnabled, toggle: toggleOverVoice15Min },
  ];

  useEffect(() => {
    return previewSound ? () => previewSound.unloadAsync() : undefined;
  }, [previewSound]);

  const handleSelectSound = async (type) => {
    toggleAlarmSoundType(type);
    try {
      if (previewSound) {
        await previewSound.unloadAsync();
      }
      if (type === 'none') {
        return; // 無音の場合はプレビュー再生なし
      }
      await Audio.setAudioModeAsync({
        playsInSilentModeIOS: playsInSilentMode,
        shouldDuckAndroid: true,
      });
      const { sound: newSound } = await Audio.Sound.createAsync(ALARM_SOUNDS[type]);
      setPreviewSound(newSound);
      await newSound.playAsync();
    } catch (e) {
      console.log('Preview sound error', e);
    }
  };

  const handlePlayVoice = async (key) => {
    try {
      if (previewSound) {
        await previewSound.unloadAsync();
      }
      setPlayingVoiceKey(key);
      await Audio.setAudioModeAsync({
        playsInSilentModeIOS: playsInSilentMode,
        shouldDuckAndroid: true,
      });
      const { sound: newSound } = await Audio.Sound.createAsync(VOICE_SAMPLES[key]);
      setPreviewSound(newSound);
      newSound.setOnPlaybackStatusUpdate((status) => {
        if (status.didJustFinish) {
          setPlayingVoiceKey(null);
        }
      });
      await newSound.playAsync();
    } catch (e) {
      console.log('Play voice error', e);
      setPlayingVoiceKey(null);
    }
  };

  const handleToggleEcoMode = (value) => {
    toggleEcoMode(value);
    if (value && !hasSeenEcoExplanation) {
      setEcoModalVisible(true);
      markEcoExplanationSeen();
    }
  };

  const bgColor = isEcoMode ? '#000' : '#F5F5F5';
  const textColor = isEcoMode ? '#fff' : '#000';
  const subTextColor = isEcoMode ? '#aaa' : '#8E8E93';
  const cardBgColor = isEcoMode ? '#0A0A0A' : '#FFFFFF';
  const cardBorderColor = isEcoMode ? '#2C2C2E' : '#E5E5EA';
  const innerBorderColor = isEcoMode ? '#1C1C1E' : '#F2F2F7';
  const sectionHeaderColor = isEcoMode ? '#8E8E93' : '#6E6E73';
  const groupSubHeaderColor = isEcoMode ? '#34C759' : '#007AFF';

  // サマリーバッジ表示用テキスト計算
  const currentAlarmLabel = ALARM_SOUND_OPTIONS.find(o => o.key === alarmSoundType)?.label || '未設定';

  const mainVoiceActiveCount = MAIN_VOICE_OPTIONS.filter(o => o.isEnabled).length;
  const mainVoiceSummary = mainVoiceActiveCount === MAIN_VOICE_OPTIONS.length 
    ? '全項目 ON' 
    : (mainVoiceActiveCount === 0 ? 'すべて OFF' : `${mainVoiceActiveCount}/${MAIN_VOICE_OPTIONS.length} 項目`);

  const prepVoiceActiveCount = PREP_VOICE_OPTIONS.filter(o => o.isEnabled).length;
  const prepVoiceSummary = prepVoiceActiveCount === PREP_VOICE_OPTIONS.length 
    ? '全項目 ON' 
    : (prepVoiceActiveCount === 0 ? 'すべて OFF' : `${prepVoiceActiveCount}/${PREP_VOICE_OPTIONS.length} 項目`);

  const overVoiceActiveCount = OVER_VOICE_OPTIONS.filter(o => o.isEnabled).length;
  const overVoiceSummary = overVoiceActiveCount === OVER_VOICE_OPTIONS.length 
    ? '全項目 ON' 
    : (overVoiceActiveCount === 0 ? 'すべて OFF' : `${overVoiceActiveCount}/${OVER_VOICE_OPTIONS.length} 項目`);

  const renderVoiceList = (options) => (
    <View style={[styles.voiceListContainer, { borderColor: innerBorderColor }]}>
      {options.map((item, index) => {
        const isPlaying = playingVoiceKey === item.key;
        const isLast = index === options.length - 1;
        return (
          <View 
            key={item.key} 
            style={[
              styles.voiceListRow, 
              { borderBottomColor: innerBorderColor },
              !isLast && { borderBottomWidth: 1 }
            ]}
          >
            {/* 左側: 試聴ボタン＋テキスト */}
            <TouchableOpacity
              style={styles.voicePreviewTouchArea}
              onPress={() => handlePlayVoice(item.key)}
              activeOpacity={0.7}
            >
              <View style={[
                styles.voicePlayIconWrapper, 
                { backgroundColor: isPlaying ? '#34C759' : (isEcoMode ? '#222' : '#E5E5EA') }
              ]}>
                <Ionicons 
                  name={isPlaying ? "volume-high" : "play"} 
                  size={15} 
                  color={isPlaying ? '#FFFFFF' : (isEcoMode ? '#FFFFFF' : '#007AFF')} 
                  style={!isPlaying ? { marginLeft: 2 } : {}}
                />
              </View>
              <View style={styles.voiceInfoTextContainer}>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <Text style={[styles.voiceRowLabel, { color: textColor }]}>
                    {item.label}
                  </Text>
                  {isPlaying && (
                    <Text style={{ fontSize: 11, color: '#34C759', fontWeight: 'bold', marginLeft: 6 }}>
                      再生中...
                    </Text>
                  )}
                </View>
                <Text style={[styles.voiceRowPhrase, { color: subTextColor }]}>
                  {item.phrase}
                </Text>
              </View>
            </TouchableOpacity>

            {/* 右側: ON/OFFトグルスイッチ */}
            <Switch
              value={item.isEnabled}
              onValueChange={item.toggle}
              trackColor={{ false: '#333', true: '#34C759' }}
              style={{ transform: [{ scaleX: 0.85 }, { scaleY: 0.85 }] }}
            />
          </View>
        );
      })}
    </View>
  );

  return (
    <ScrollView 
      ref={scrollViewRef}
      style={[styles.container, { backgroundColor: bgColor }]}
      contentContainerStyle={styles.scrollContent}
      showsVerticalScrollIndicator={false}
    >
      <Text style={[styles.title, { color: textColor }]}>設定</Text>
      
      {/* 1. エコモード設定グループカード */}
      <Text style={[styles.sectionTitle, { color: sectionHeaderColor }]}>エコモード設定</Text>
      <View style={[styles.groupCard, { backgroundColor: cardBgColor, borderColor: cardBorderColor }]}>
        {/* 親トグル */}
        <View style={[styles.settingRowInCard, isEcoMode && { borderBottomWidth: 1, borderBottomColor: innerBorderColor }]}>
          <View style={styles.settingTitleWithInfo}>
            <Text style={[styles.settingText, { color: textColor, fontWeight: '600' }]}>エコモード（極限省電力）</Text>
            <TouchableOpacity 
              onPress={() => setEcoModalVisible(true)}
              style={styles.infoButton}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              activeOpacity={0.7}
            >
              <Ionicons name="information-circle-outline" size={20} color={isEcoMode ? '#34C759' : '#007AFF'} />
            </TouchableOpacity>
          </View>
          <Switch
            value={isEcoMode}
            onValueChange={handleToggleEcoMode}
          />
        </View>

        {/* サブ設定一覧 */}
        {isEcoMode && (
          <View style={styles.subSettingsContainer}>
            <View style={[styles.subSettingRow, { borderBottomColor: innerBorderColor }]}>
              <Text style={[styles.subSettingText, { color: textColor }]}>└ 時計を表示</Text>
              <Switch
                value={isEcoClockEnabled}
                onValueChange={toggleEcoClock}
                trackColor={{ false: '#333', true: '#34C759' }}
                style={{ transform: [{ scaleX: 0.8 }, { scaleY: 0.8 }] }}
              />
            </View>

            <View style={[styles.subSettingRow, { borderBottomColor: innerBorderColor }]}>
              <Text style={[styles.subSettingText, { color: textColor }]}>└ 電池残量を表示</Text>
              <Switch
                value={isEcoBatteryEnabled}
                onValueChange={toggleEcoBattery}
                trackColor={{ false: '#333', true: '#34C759' }}
                style={{ transform: [{ scaleX: 0.8 }, { scaleY: 0.8 }] }}
              />
            </View>

            <View style={[styles.subSettingRow, { borderBottomColor: innerBorderColor }]}>
              <Text style={[styles.subSettingText, { color: textColor }]}>└ タブをアイコンで表示（オフで点）</Text>
              <Switch
                value={isEcoNavIconEnabled}
                onValueChange={toggleEcoNavIcon}
                trackColor={{ false: '#333', true: '#34C759' }}
                style={{ transform: [{ scaleX: 0.8 }, { scaleY: 0.8 }] }}
              />
            </View>

            {!isEcoNavIconEnabled && (
              <View style={[styles.subSettingRow, { borderBottomColor: innerBorderColor, paddingLeft: 24 }]}>
                <Text style={[styles.subSettingText, { color: subTextColor }]}>└ 選択中のタブだけ表示する</Text>
                <Switch
                  value={isEcoNavActiveDot}
                  onValueChange={toggleEcoNavActiveDot}
                  trackColor={{ false: '#333', true: '#34C759' }}
                  style={{ transform: [{ scaleX: 0.75 }, { scaleY: 0.75 }] }}
                />
              </View>
            )}

            <View style={[styles.subSettingRow, { borderBottomColor: innerBorderColor }]}>
              <Text style={[styles.subSettingText, { color: textColor }]}>└ タブの境界線を表示</Text>
              <Switch
                value={isEcoBorderEnabled}
                onValueChange={toggleEcoBorder}
                trackColor={{ false: '#333', true: '#34C759' }}
                style={{ transform: [{ scaleX: 0.8 }, { scaleY: 0.8 }] }}
              />
            </View>

            <View style={[styles.subSettingRow, { borderBottomWidth: 0 }]}>
              <Text style={[styles.subSettingText, { color: textColor }]}>└ タイマーリングを表示</Text>
              <Switch
                value={isEcoIndicatorEnabled}
                onValueChange={toggleEcoIndicator}
                trackColor={{ false: '#333', true: '#34C759' }}
                style={{ transform: [{ scaleX: 0.8 }, { scaleY: 0.8 }] }}
              />
            </View>
          </View>
        )}
      </View>

      {/* 2. 通常モード設定グループカード */}
      <Text style={[styles.sectionTitle, { color: sectionHeaderColor }]}>通常モード設定</Text>
      <View style={[styles.groupCard, { backgroundColor: cardBgColor, borderColor: cardBorderColor }]}>
        <View style={[styles.settingRowInCard, { borderBottomWidth: 1, borderBottomColor: innerBorderColor }]}>
          <Text style={[styles.settingText, { color: textColor }]}>ステータスバー（時計・電池）を表示</Text>
          <Switch
            value={isNormalStatusBarEnabled}
            onValueChange={toggleNormalStatusBar}
            trackColor={{ false: '#333', true: '#34C759' }}
            style={{ transform: [{ scaleX: 0.8 }, { scaleY: 0.8 }] }}
          />
        </View>

        {isNormalStatusBarEnabled && (
          <View style={[styles.settingRowInCard, { borderBottomWidth: 1, borderBottomColor: innerBorderColor, paddingLeft: 24 }]}>
            <Text style={[styles.settingText, { color: subTextColor }]}>└ タイマー作動中は自動で消す</Text>
            <Switch
              value={isNormalStatusBarAutoHide}
              onValueChange={toggleNormalStatusBarAutoHide}
              trackColor={{ false: '#333', true: '#34C759' }}
              style={{ transform: [{ scaleX: 0.75 }, { scaleY: 0.75 }] }}
            />
          </View>
        )}

        <View style={[styles.settingRowInCard, { borderBottomWidth: 0 }]}>
          <Text style={[styles.settingText, { color: textColor }]}>タイマーリングを表示</Text>
          <Switch
            value={isNormalIndicatorEnabled}
            onValueChange={toggleNormalIndicator}
            trackColor={{ false: '#333', true: '#34C759' }}
            style={{ transform: [{ scaleX: 0.8 }, { scaleY: 0.8 }] }}
          />
        </View>
      </View>

      {/* 3. アラーム・サウンド設定グループカード */}
      <Text style={[styles.sectionTitle, { color: sectionHeaderColor }]}>アラーム・サウンド設定</Text>
      <View style={[styles.groupCard, { backgroundColor: cardBgColor, borderColor: cardBorderColor }]}>
        {/* マナーモード時でも鳴らすトグル */}
        <View style={[styles.settingRowInCard, { borderBottomWidth: 1, borderBottomColor: innerBorderColor }]}>
          <View style={styles.settingTextContainer}>
            <Text style={[styles.settingText, { color: textColor }]}>マナーモード時でも鳴らす</Text>
            <Text style={[styles.settingDescription, { color: subTextColor }]}>端末の消音スイッチ（サイレントモード）時でもアラーム音・音声を再生します</Text>
          </View>
          <Switch
            value={playsInSilentMode}
            onValueChange={togglePlaysInSilentMode}
            trackColor={{ false: '#333', true: '#34C759' }}
          />
        </View>

        {/* バイブレーション設定ブロック（親トグル＋インセットサブ設定） */}
        <View style={{ borderBottomWidth: 1, borderBottomColor: innerBorderColor }}>
          <View style={[styles.settingRowInCard, { borderBottomWidth: 0, paddingBottom: isVibrationEnabled ? 8 : 14 }]}>
            <View style={styles.settingTextContainer}>
              <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' }}>
                <Ionicons name="phone-portrait-outline" size={18} color={textColor} style={{ marginRight: 6 }} />
                <Text style={[styles.settingText, { color: textColor, fontWeight: '600' }]}>バイブレーション（振動）</Text>
                {isVibrationEnabled && (
                  <TouchableOpacity 
                    onPress={handleTestVibration} 
                    style={{ 
                      marginLeft: 8, 
                      flexDirection: 'row', 
                      alignItems: 'center', 
                      paddingVertical: 3, 
                      paddingHorizontal: 8, 
                      borderRadius: 12, 
                      backgroundColor: isTestingVibration ? '#FF3B30' : (isEcoMode ? '#1C2E42' : '#EBF4FF') 
                    }}
                    activeOpacity={0.7}
                  >
                    <Ionicons 
                      name={isTestingVibration ? "stop-circle-outline" : "radio-outline"} 
                      size={13} 
                      color={isTestingVibration ? '#FFF' : '#007AFF'} 
                      style={{ marginRight: 3 }} 
                    />
                    <Text style={{ fontSize: 11, fontWeight: '600', color: isTestingVibration ? '#FFF' : '#007AFF' }}>
                      {isTestingVibration ? "停止" : "振動テスト"}
                    </Text>
                  </TouchableOpacity>
                )}
              </View>
              <Text style={[styles.settingDescription, { color: subTextColor, marginTop: 2 }]}>
                タイマー終了時や警告タイミングで端末を振動させます
              </Text>
            </View>
            <Switch
              value={isVibrationEnabled}
              onValueChange={toggleVibrationEnabled}
              trackColor={{ false: '#333', true: '#34C759' }}
            />
          </View>

          {/* バイブレーション設定（強度切替 ＆ タイミング個別設定） */}
          {isVibrationEnabled && (
            <View style={{ marginHorizontal: 16, marginBottom: 14 }}>
              {/* 1. 振動の強さセレクター */}
              <View style={{
                marginBottom: 10,
                padding: 10,
                borderRadius: 10,
                backgroundColor: isEcoMode ? '#141414' : '#F2F4F8',
                borderWidth: 1,
                borderColor: isEcoMode ? '#222' : '#E2E6EE',
              }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8, justifyContent: 'space-between', flexWrap: 'wrap' }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <Ionicons name="speedometer-outline" size={14} color={isEcoMode ? '#34C759' : '#007AFF'} style={{ marginRight: 5 }} />
                    <Text style={{ fontSize: 13, fontWeight: '700', color: textColor }}>振動の強さ</Text>
                  </View>
                  <Text style={{ fontSize: 11, color: subTextColor }}>
                    {vibrationIntensity === 'strong' ? '激しい連続振動（気付きやすい）' : (vibrationIntensity === 'gentle' ? '手元だけの静かな振動' : 'バランスの良い標準振動')}
                  </Text>
                </View>
                {/* 3分割セグメントボタン */}
                <View style={{
                  flexDirection: 'row',
                  backgroundColor: isEcoMode ? '#000000' : '#E1E5EC',
                  borderRadius: 8,
                  padding: 2,
                }}>
                  {[
                    { key: 'gentle', label: '控えめ' },
                    { key: 'normal', label: '標準' },
                    { key: 'strong', label: '★ 強力 (推奨)' },
                  ].map((item) => {
                    const isSelected = vibrationIntensity === item.key;
                    return (
                      <TouchableOpacity
                        key={item.key}
                        style={{
                          flex: 1,
                          paddingVertical: 7,
                          alignItems: 'center',
                          justifyContent: 'center',
                          borderRadius: 6,
                          backgroundColor: isSelected ? (isEcoMode ? '#34C759' : '#007AFF') : 'transparent',
                        }}
                        onPress={() => {
                          saveVibrationIntensity(item.key);
                          // 切り替え時にその強さのプレビューパルスを発生
                          if (item.key === 'strong') {
                            Vibration.vibrate([0, 400, 100, 400]);
                          } else if (item.key === 'gentle') {
                            Vibration.vibrate(50);
                          } else {
                            Vibration.vibrate([0, 150, 80, 150]);
                          }
                        }}
                        activeOpacity={0.7}
                      >
                        <Text style={{
                          fontSize: 12,
                          fontWeight: isSelected ? '700' : '500',
                          color: isSelected ? '#FFFFFF' : subTextColor,
                        }}>
                          {item.label}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>

              {/* 2. タイミング個別設定インセットカード */}
              <View style={{
                borderRadius: 10,
                backgroundColor: isEcoMode ? '#141414' : '#F2F4F8',
                borderLeftWidth: 3,
                borderLeftColor: '#34C759',
                borderWidth: 1,
                borderColor: isEcoMode ? '#222' : '#E2E6EE',
                paddingVertical: 4,
                paddingHorizontal: 12,
              }}>
                <Text style={{ fontSize: 12, fontWeight: '700', color: subTextColor, marginTop: 6, marginBottom: 4, letterSpacing: 0.5 }}>
                  振動するタイミング
                </Text>

                {/* ① スタート事前準備時間 */}
                <View style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  paddingVertical: 8,
                  borderBottomWidth: 1,
                  borderBottomColor: innerBorderColor,
                }}>
                  <View style={{ flex: 1, paddingRight: 8 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                      <Ionicons name="hourglass-outline" size={14} color={isEcoMode ? '#FF9500' : '#D97706'} style={{ marginRight: 6 }} />
                      <Text style={{ fontSize: 13, fontWeight: '600', color: textColor }}>スタート事前準備時間</Text>
                    </View>
                    <Text style={{ fontSize: 11, color: subTextColor, marginTop: 2 }}>開始コール・直前カウントダウン時の振動</Text>
                  </View>
                  <Switch
                    value={isVibPrepEnabled}
                    onValueChange={toggleVibPrep}
                    trackColor={{ false: '#333', true: '#34C759' }}
                    style={{ transform: [{ scaleX: 0.8 }, { scaleY: 0.8 }] }}
                  />
                </View>

                {/* ② タイマー計測中（警告） */}
                <View style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  paddingVertical: 8,
                  borderBottomWidth: 1,
                  borderBottomColor: innerBorderColor,
                }}>
                  <View style={{ flex: 1, paddingRight: 8 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                      <Ionicons name="warning-outline" size={14} color={isEcoMode ? '#FFD60A' : '#CA8A04'} style={{ marginRight: 6 }} />
                      <Text style={{ fontSize: 13, fontWeight: '600', color: textColor }}>タイマー計測中（残り時間警告）</Text>
                    </View>
                    <Text style={{ fontSize: 11, color: subTextColor, marginTop: 2 }}>残り1分・30秒・10秒到達時のパルス振動</Text>
                  </View>
                  <Switch
                    value={isVibWarningEnabled}
                    onValueChange={toggleVibWarning}
                    trackColor={{ false: '#333', true: '#34C759' }}
                    style={{ transform: [{ scaleX: 0.8 }, { scaleY: 0.8 }] }}
                  />
                </View>

                {/* ③ 終了時（タイムアップ） */}
                <View style={{
                  paddingVertical: 8,
                  borderBottomWidth: 1,
                  borderBottomColor: innerBorderColor,
                }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                    <View style={{ flex: 1, paddingRight: 8 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                        <Ionicons name="notifications-outline" size={14} color={isEcoMode ? '#34C759' : '#007AFF'} style={{ marginRight: 6 }} />
                        <Text style={{ fontSize: 13, fontWeight: '600', color: textColor }}>終了時（タイムアップ）</Text>
                      </View>
                      <Text style={{ fontSize: 11, color: subTextColor, marginTop: 2 }}>0秒到達時のアラーム連動振動</Text>
                    </View>
                    <Switch
                      value={isVibFinishEnabled}
                      onValueChange={toggleVibFinish}
                      trackColor={{ false: '#333', true: '#34C759' }}
                      style={{ transform: [{ scaleX: 0.8 }, { scaleY: 0.8 }] }}
                    />
                  </View>

                  {/* └ 終了時3秒で自動停止（サブトグル） */}
                  {isVibFinishEnabled && (
                    <View style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      marginTop: 6,
                      marginLeft: 16,
                      paddingVertical: 4,
                      paddingHorizontal: 8,
                      borderRadius: 6,
                      backgroundColor: isEcoMode ? '#0A0A0A' : '#E8ECF2',
                    }}>
                      <View style={{ flex: 1, paddingRight: 6 }}>
                        <Text style={{ fontSize: 12, fontWeight: '600', color: textColor }}>└ 3秒で自動停止</Text>
                        <Text style={{ fontSize: 10, color: subTextColor }}>超過時間中の連続振動を防止します</Text>
                      </View>
                      <Switch
                        value={isVibration3SecOnly}
                        onValueChange={toggleVibration3SecOnly}
                        trackColor={{ false: '#333', true: '#34C759' }}
                        style={{ transform: [{ scaleX: 0.75 }, { scaleY: 0.75 }] }}
                      />
                    </View>
                  )}
                </View>

                {/* ④ カウントアップ（超過時間） */}
                <View style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  paddingVertical: 8,
                }}>
                  <View style={{ flex: 1, paddingRight: 8 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                      <Ionicons name="trending-up-outline" size={14} color={isEcoMode ? '#FF453A' : '#DC2626'} style={{ marginRight: 6 }} />
                      <Text style={{ fontSize: 13, fontWeight: '600', color: textColor }}>カウントアップ（超過時間）</Text>
                    </View>
                    <Text style={{ fontSize: 11, color: subTextColor, marginTop: 2 }}>超過時間突入・経過コール時の振動</Text>
                  </View>
                  <Switch
                    value={isVibOvertimeEnabled}
                    onValueChange={toggleVibOvertime}
                    trackColor={{ false: '#333', true: '#34C759' }}
                    style={{ transform: [{ scaleX: 0.8 }, { scaleY: 0.8 }] }}
                  />
                </View>
              </View>
            </View>
          )}
        </View>

        {/* 2. アラーム音の選択（アコーディオン） */}
        <View style={{ borderBottomWidth: 1, borderBottomColor: innerBorderColor }}>
          <TouchableOpacity
            style={styles.accordionHeader}
            onPress={() => toggleAccordion(setIsAlarmSoundOpen)}
            activeOpacity={0.7}
          >
            <View style={styles.accordionTitleContainer}>
              <Ionicons name="musical-notes-outline" size={18} color={textColor} style={{ marginRight: 8 }} />
              <Text style={[styles.settingText, { color: textColor, fontWeight: '600' }]}>アラーム音の選択</Text>
            </View>
            <View style={styles.accordionRightContainer}>
              <View style={[styles.summaryBadge, { backgroundColor: isEcoMode ? '#1C2E42' : '#EBF4FF' }]}>
                <Text style={[styles.summaryBadgeText, { color: '#007AFF' }]}>{currentAlarmLabel}</Text>
              </View>
              <Ionicons 
                name={isAlarmSoundOpen ? "chevron-up" : "chevron-down"} 
                size={18} 
                color={subTextColor} 
                style={{ marginLeft: 6 }}
              />
            </View>
          </TouchableOpacity>

          {isAlarmSoundOpen && (
            <View style={styles.accordionContentContainer}>
              <Text style={{ fontSize: 12, color: subTextColor, marginBottom: 12 }}>
                タップして試聴・選択できます
              </Text>
              <View style={styles.soundGrid}>
                {ALARM_SOUND_OPTIONS.map((item) => {
                  const isSelected = alarmSoundType === item.key;
                  const isNone = item.key === 'none';
                  return (
                    <TouchableOpacity
                      key={item.key}
                      style={[
                        styles.soundOptionTile,
                        { 
                          backgroundColor: isEcoMode ? (isSelected ? '#13283E' : '#141414') : (isSelected ? '#EBF4FF' : '#F2F2F7'), 
                          borderColor: isSelected ? '#007AFF' : (isEcoMode ? '#2C2C2E' : '#E5E5EA') 
                        },
                        isSelected && { borderWidth: 2 }
                      ]}
                      onPress={() => handleSelectSound(item.key)}
                      activeOpacity={0.7}
                    >
                      {/* 選択中チェックバッジ */}
                      {isSelected && (
                        <View style={styles.selectedCheckBadge}>
                          <Ionicons name="checkmark" size={12} color="#FFFFFF" />
                        </View>
                      )}

                      <Ionicons 
                        name={isNone ? (isSelected ? "volume-mute" : "volume-mute-outline") : (isSelected ? "volume-high" : "volume-medium-outline")} 
                        size={22} 
                        color={isSelected ? '#007AFF' : (isEcoMode ? '#888' : '#666')} 
                        style={{ marginBottom: 4 }}
                      />
                      <Text style={[styles.soundOptionTitle, { color: isSelected ? '#007AFF' : textColor, fontWeight: isSelected ? 'bold' : '600' }]}>
                        {item.label}
                      </Text>
                      <Text style={{ fontSize: 11, color: isSelected ? '#007AFF' : subTextColor, marginTop: 2, textAlign: 'center' }}>
                        {item.desc}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          )}
        </View>

        {/* 3. タイマー計測中 アナウンス（アコーディオン） */}
        <View style={{ borderBottomWidth: 1, borderBottomColor: innerBorderColor }}>
          <TouchableOpacity
            style={styles.accordionHeader}
            onPress={() => toggleAccordion(setIsMainVoiceOpen)}
            activeOpacity={0.7}
          >
            <View style={styles.accordionTitleContainer}>
              <Ionicons name="timer-outline" size={18} color={textColor} style={{ marginRight: 8 }} />
              <Text style={[styles.settingText, { color: textColor, fontWeight: '600' }]}>タイマー計測中</Text>
            </View>
            <View style={styles.accordionRightContainer}>
              <View style={[styles.summaryBadge, { backgroundColor: isEcoMode ? (mainVoiceActiveCount > 0 ? '#1C2E42' : '#222') : (mainVoiceActiveCount > 0 ? '#EBF4FF' : '#F2F2F7') }]}>
                <Text style={[styles.summaryBadgeText, { color: mainVoiceActiveCount > 0 ? '#007AFF' : subTextColor }]}>
                  {mainVoiceSummary}
                </Text>
              </View>
              <Ionicons 
                name={isMainVoiceOpen ? "chevron-up" : "chevron-down"} 
                size={18} 
                color={subTextColor} 
                style={{ marginLeft: 6 }}
              />
            </View>
          </TouchableOpacity>

          {isMainVoiceOpen && (
            <View style={styles.accordionContentContainer}>
              <Text style={{ fontSize: 12, color: subTextColor, marginBottom: 12 }}>
                タイマー計測中に鳴らす音声を個別に設定できます。左側タップで試聴可能です。
              </Text>
              {renderVoiceList(MAIN_VOICE_OPTIONS)}
            </View>
          )}
        </View>

        {/* 4. スタート事前準備時間 アナウンス（アコーディオン） */}
        <View style={{ borderBottomWidth: 1, borderBottomColor: innerBorderColor }}>
          <TouchableOpacity
            style={styles.accordionHeader}
            onPress={() => toggleAccordion(setIsPrepVoiceOpen)}
            activeOpacity={0.7}
          >
            <View style={styles.accordionTitleContainer}>
              <Ionicons name="hourglass-outline" size={18} color={textColor} style={{ marginRight: 8 }} />
              <Text style={[styles.settingText, { color: textColor, fontWeight: '600' }]}>スタート事前準備時間</Text>
            </View>
            <View style={styles.accordionRightContainer}>
              <View style={[styles.summaryBadge, { backgroundColor: isEcoMode ? (prepVoiceActiveCount > 0 ? '#1C2E42' : '#222') : (prepVoiceActiveCount > 0 ? '#EBF4FF' : '#F2F2F7') }]}>
                <Text style={[styles.summaryBadgeText, { color: prepVoiceActiveCount > 0 ? '#007AFF' : subTextColor }]}>
                  {prepVoiceSummary}
                </Text>
              </View>
              <Ionicons 
                name={isPrepVoiceOpen ? "chevron-up" : "chevron-down"} 
                size={18} 
                color={subTextColor} 
                style={{ marginLeft: 6 }}
              />
            </View>
          </TouchableOpacity>

          {isPrepVoiceOpen && (
            <View style={styles.accordionContentContainer}>
              <Text style={{ fontSize: 12, color: subTextColor, marginBottom: 12 }}>
                事前準備時間中に鳴らす音声を個別に設定できます。左側タップで試聴可能です。
              </Text>
              {renderVoiceList(PREP_VOICE_OPTIONS)}
            </View>
          )}
        </View>

        {/* 5. カウントアップ・超過時間 アナウンス（アコーディオン） */}
        <View style={{ borderBottomWidth: 0 }}>
          <TouchableOpacity
            style={styles.accordionHeader}
            onPress={() => toggleAccordion(setIsOverVoiceOpen)}
            activeOpacity={0.7}
          >
            <View style={styles.accordionTitleContainer}>
              <Ionicons name="trending-up-outline" size={18} color={textColor} style={{ marginRight: 8 }} />
              <Text style={[styles.settingText, { color: textColor, fontWeight: '600' }]}>カウントアップ・超過時間</Text>
            </View>
            <View style={styles.accordionRightContainer}>
              <View style={[styles.summaryBadge, { backgroundColor: isEcoMode ? (overVoiceActiveCount > 0 ? '#1C2E42' : '#222') : (overVoiceActiveCount > 0 ? '#EBF4FF' : '#F2F2F7') }]}>
                <Text style={[styles.summaryBadgeText, { color: overVoiceActiveCount > 0 ? '#007AFF' : subTextColor }]}>
                  {overVoiceSummary}
                </Text>
              </View>
              <Ionicons 
                name={isOverVoiceOpen ? "chevron-up" : "chevron-down"} 
                size={18} 
                color={subTextColor} 
                style={{ marginLeft: 6 }}
              />
            </View>
          </TouchableOpacity>

          {isOverVoiceOpen && (
            <View style={styles.accordionContentContainer}>
              <Text style={{ fontSize: 12, color: subTextColor, marginBottom: 12 }}>
                目標タイム終了後のカウントアップ中に鳴らす音声を個別に設定できます。左側タップで試聴可能です。
              </Text>
              {renderVoiceList(OVER_VOICE_OPTIONS)}
            </View>
          )}
        </View>
      </View>

      {/* 4. その他設定グループカード */}
      <Text style={[styles.sectionTitle, { color: sectionHeaderColor }]}>機能・表示設定</Text>
      <View style={[styles.groupCard, { backgroundColor: cardBgColor, borderColor: cardBorderColor }]}>
        {/* Proプラン（プレミアム会員）行 */}
        <TouchableOpacity 
          style={[styles.settingRowInCard, { borderBottomWidth: 1, borderBottomColor: innerBorderColor }]}
          onPress={() => setProModalVisible(true)}
          activeOpacity={0.7}
        >
          <View style={styles.settingTextContainer}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Text style={{ fontSize: 16, marginRight: 6 }}>👑</Text>
              <Text style={[styles.settingText, { color: textColor }]}>Proプラン（月額100円）</Text>
            </View>
            <Text style={[styles.settingDescription, { color: subTextColor }]}>
              広告の完全非表示 ＆ 練習記録を無制限に保存
            </Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            {isProMode ? (
              <View style={[styles.summaryBadge, { backgroundColor: '#1C3A27', borderColor: '#34C759', borderWidth: 1 }]}>
                <Text style={[styles.summaryBadgeText, { color: '#34C759', fontWeight: '700' }]}>有効 ✓</Text>
              </View>
            ) : (
              <View style={[styles.summaryBadge, { backgroundColor: isEcoMode ? '#222' : '#E5E5EA' }]}>
                <Text style={[styles.summaryBadgeText, { color: '#007AFF' }]}>詳細を見る ›</Text>
              </View>
            )}
          </View>
        </TouchableOpacity>

        <View style={[styles.settingRowInCard, { borderBottomWidth: 0 }]}>
          <View style={styles.settingTextContainer}>
            <Text style={[styles.settingText, { color: textColor }]}>カラーインジケーター</Text>
            <Text style={[styles.settingDescription, { color: subTextColor }]}>10分以下のタイマーでリングの色が残量に応じて青→黄→赤に変化します</Text>
            {/* 視覚的カラーバー（実比率7:2:1 & 凡例） */}
            <View style={styles.colorIndicatorBarWrapper}>
              <View style={styles.colorIndicatorBar}>
                <View style={[styles.colorSegment, { flex: 7, backgroundColor: '#007AFF', borderTopLeftRadius: 4, borderBottomLeftRadius: 4 }]} />
                <View style={[styles.colorBarDivider, { backgroundColor: cardBgColor }]} />
                <View style={[styles.colorSegment, { flex: 2, backgroundColor: '#FFCC00' }]} />
                <View style={[styles.colorBarDivider, { backgroundColor: cardBgColor }]} />
                <View style={[styles.colorSegment, { flex: 1, backgroundColor: '#FF3B30', borderTopRightRadius: 4, borderBottomRightRadius: 4 }]} />
              </View>
              <View style={styles.colorBarLegend}>
                <View style={styles.legendItem}>
                  <View style={[styles.legendDot, { backgroundColor: '#007AFF' }]} />
                  <Text style={[styles.legendText, { color: subTextColor }]}>青: 30%超</Text>
                </View>
                <View style={styles.legendItem}>
                  <View style={[styles.legendDot, { backgroundColor: '#FFCC00' }]} />
                  <Text style={[styles.legendText, { color: subTextColor }]}>黄: 30%以下</Text>
                </View>
                <View style={styles.legendItem}>
                  <View style={[styles.legendDot, { backgroundColor: '#FF3B30' }]} />
                  <Text style={[styles.legendText, { color: subTextColor }]}>赤: 10%以下</Text>
                </View>
              </View>
            </View>
          </View>
          <Switch
            value={isColorIndicator}
            onValueChange={toggleColorIndicator}
            trackColor={{ false: '#333', true: '#34C759' }}
          />
        </View>
      </View>

      {/* 5. 情報・利用規約セクション（Apple審査必須要件） */}
      <Text style={[styles.sectionTitle, { color: sectionHeaderColor }]}>情報・規約</Text>
      <View style={[styles.groupCard, { backgroundColor: cardBgColor, borderColor: cardBorderColor }]}>
        <TouchableOpacity 
          style={[styles.settingRowInCard, { borderBottomWidth: 1, borderBottomColor: innerBorderColor }]}
          onPress={() => Linking.openURL('https://www.apple.com/legal/internet-services/itunes/dev/stdeula/')}
        >
          <Text style={[styles.settingText, { color: textColor }]}>利用規約（EULA）</Text>
          <Ionicons name="chevron-forward" size={18} color={subTextColor} />
        </TouchableOpacity>

        <TouchableOpacity 
          style={[styles.settingRowInCard, { borderBottomWidth: 1, borderBottomColor: innerBorderColor }]}
          onPress={() => Linking.openURL('https://litthairdesign.notion.site/AssistTimer-Privacy-Policy')}
        >
          <Text style={[styles.settingText, { color: textColor }]}>プライバシーポリシー</Text>
          <Ionicons name="chevron-forward" size={18} color={subTextColor} />
        </TouchableOpacity>

        <TouchableOpacity 
          style={[styles.settingRowInCard, { borderBottomWidth: 0 }]}
          onPress={() => setProModalVisible(true)}
        >
          <Text style={[styles.settingText, { color: textColor }]}>購入の復元（Restore）</Text>
          <Ionicons name="chevron-forward" size={18} color={subTextColor} />
        </TouchableOpacity>
      </View>

      {/* 6. 最下部 PROモード案内・購入ボタン */}
      <View style={{ marginTop: 28, marginBottom: 30, alignItems: 'center' }}>
        {isProMode ? (
          <TouchableOpacity 
            style={[styles.proStatusCard, { backgroundColor: isEcoMode ? '#0D2818' : '#1C3A27', borderColor: '#34C759' }]}
            onPress={() => setProModalVisible(true)}
            activeOpacity={0.8}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4 }}>
              <Text style={{ fontSize: 18, marginRight: 6 }}>👑</Text>
              <Text style={{ color: '#34C759', fontSize: 17, fontWeight: '700' }}>PROモード有効中</Text>
            </View>
            <Text style={{ color: '#88D49E', fontSize: 13, textAlign: 'center' }}>
              広告なし・記録機能の無制限解放が適用されています
            </Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity 
            style={[styles.proCtaButton, { shadowColor: '#007AFF' }]}
            onPress={() => setProModalVisible(true)}
            activeOpacity={0.85}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
              <Text style={{ fontSize: 20, marginRight: 8 }}>👑</Text>
              <Text style={styles.proCtaTitle}>PROモードにする</Text>
            </View>
            <Text style={styles.proCtaDesc}>
              広告なし ＆ 記録機能の無制限解放（初月1ヶ月無料・月額100円）
            </Text>
          </TouchableOpacity>
        )}
      </View>

      {/* エコモード説明モーダル */}
      <Modal
        animationType="fade"
        transparent={true}
        visible={ecoModalVisible}
        onRequestClose={() => setEcoModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.ecoModalCard}>
            <View style={styles.ecoModalHeader}>
              <View style={styles.ecoIconBadge}>
                <Ionicons name="leaf" size={26} color="#34C759" />
              </View>
              <Text style={styles.ecoModalTitle}>エコモード（極限省電力）</Text>
            </View>

            <View style={styles.ecoModalBody}>
              <View style={styles.ecoSection}>
                <View style={styles.ecoSectionHeader}>
                  <Ionicons name="contrast" size={18} color="#34C759" style={styles.ecoSectionIcon} />
                  <Text style={styles.ecoSectionTitle}>漆黒画面でバッテリーを最大節約</Text>
                </View>
                <Text style={styles.ecoSectionText}>
                  有機EL（OLED）ディスプレイは、黒い部分の発光が完全に停止します。画面全体を真っ黒にすることで、バッテリー消費を最大限まで抑えられます。
                </Text>
              </View>

              <View style={styles.ecoSection}>
                <View style={styles.ecoSectionHeader}>
                  <Ionicons name="options" size={18} color="#34C759" style={styles.ecoSectionIcon} />
                  <Text style={styles.ecoSectionTitle}>カスタムして極限まで省電力化</Text>
                </View>
                <Text style={styles.ecoSectionText}>
                  エコモード中は、時計・電池残量・タイマーリング・タブ表示などを個別にOFFにできます。不要な表示を削るほど、極限まで省電力を高めることができます。
                </Text>
              </View>
            </View>

            <TouchableOpacity
              style={styles.ecoCloseButton}
              onPress={() => setEcoModalVisible(false)}
              activeOpacity={0.8}
            >
              <Text style={styles.ecoCloseButtonText}>了解しました</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Proプラン（月額100円）購入・管理モーダル */}
      <ProSubscriptionModal visible={proModalVisible} onClose={() => setProModalVisible(false)} />

    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollContent: {
    padding: 20,
    paddingTop: 10,
    paddingBottom: 50,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 24,
    marginTop: 10,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 8,
    marginLeft: 4,
    letterSpacing: 0.5,
  },
  groupCard: {
    borderRadius: 16,
    borderWidth: 1,
    overflow: 'hidden',
    marginBottom: 24,
  },
  settingRowInCard: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  subSettingsContainer: {
    backgroundColor: 'transparent',
  },
  subSettingRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 11,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
  },
  settingTitleWithInfo: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  infoButton: {
    marginLeft: 8,
    padding: 4,
  },
  settingText: {
    fontSize: 16,
  },
  subSettingText: {
    fontSize: 14,
  },
  settingTextContainer: {
    flex: 1,
    marginRight: 10,
  },
  settingDescription: {
    fontSize: 12,
    marginTop: 4,
    lineHeight: 16,
  },
  modalOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.7)',
    padding: 20,
  },
  ecoModalCard: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: '#1C1C1E',
    borderRadius: 20,
    padding: 24,
    borderWidth: 1,
    borderColor: '#2C2C2E',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.5,
    shadowRadius: 20,
    elevation: 10,
  },
  ecoModalHeader: {
    alignItems: 'center',
    marginBottom: 20,
  },
  ecoIconBadge: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: 'rgba(52, 199, 89, 0.15)',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 12,
  },
  ecoModalTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#FFFFFF',
    textAlign: 'center',
  },
  ecoModalBody: {
    marginBottom: 24,
  },
  ecoSection: {
    backgroundColor: '#2C2C2E',
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
  },
  ecoSectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
  },
  ecoSectionIcon: {
    marginRight: 8,
  },
  ecoSectionTitle: {
    fontSize: 15,
    fontWeight: 'bold',
    color: '#FFFFFF',
  },
  ecoSectionText: {
    fontSize: 13,
    color: '#C7C7CC',
    lineHeight: 19,
  },
  ecoCloseButton: {
    backgroundColor: '#34C759',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    shadowColor: '#34C759',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  ecoCloseButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: 'bold',
  },
  ecoCloseButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: 'bold',
  },
  soundGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: 10,
  },
  soundOptionTile: {
    width: '48%',
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 8,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  selectedCheckBadge: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#007AFF',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.2,
    shadowRadius: 2,
    elevation: 2,
  },
  soundOptionTitle: {
    fontSize: 13,
    textAlign: 'center',
  },
  voiceListContainer: {
    borderRadius: 12,
    borderWidth: 1,
    overflow: 'hidden',
  },
  voiceListRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  voicePreviewTouchArea: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: 10,
  },
  voicePlayIconWrapper: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  voiceInfoTextContainer: {
    flex: 1,
  },
  voiceRowLabel: {
    fontSize: 14,
    fontWeight: '600',
  },
  voiceRowPhrase: {
    fontSize: 12,
    marginTop: 2,
  },
  accordionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  accordionTitleContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  accordionRightContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  summaryBadge: {
    paddingHorizontal: 9,
    paddingVertical: 3,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  summaryBadgeText: {
    fontSize: 12,
    fontWeight: '600',
  },
  accordionContentContainer: {
    paddingHorizontal: 16,
    paddingBottom: 16,
    paddingTop: 4,
  },
  colorIndicatorBarWrapper: {
    marginTop: 8,
  },
  colorIndicatorBar: {
    flexDirection: 'row',
    height: 7,
    borderRadius: 3.5,
    overflow: 'hidden',
    marginBottom: 6,
  },
  colorSegment: {
    height: '100%',
  },
  colorBarDivider: {
    width: 1.5,
    height: '100%',
  },
  colorBarLegend: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 1,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  legendDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 4,
  },
  legendText: {
    fontSize: 10,
    fontWeight: '500',
  },
  proCtaButton: {
    width: '100%',
    backgroundColor: '#007AFF',
    paddingVertical: 16,
    paddingHorizontal: 20,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
  },
  proCtaTitle: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  proCtaDesc: {
    color: 'rgba(255, 255, 255, 0.9)',
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
  },
  proStatusCard: {
    width: '100%',
    paddingVertical: 16,
    paddingHorizontal: 20,
    borderRadius: 16,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

