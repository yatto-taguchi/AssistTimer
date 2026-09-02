import React, { useContext, useState } from 'react';
import { StyleSheet, Text, View, Switch, TouchableOpacity, Modal, TextInput, KeyboardAvoidingView, Platform, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AppContext } from '../utils/AppContext';

export default function SettingsScreen() {
  const { 
    isEcoMode, toggleEcoMode, 
    isEcoClockEnabled, toggleEcoClock,
    isEcoBatteryEnabled, toggleEcoBattery,
    isEcoNavIconEnabled, toggleEcoNavIcon,
    isEcoNavActiveDot, toggleEcoNavActiveDot,
    isEcoBorderEnabled, toggleEcoBorder,
    isEcoIndicatorEnabled, toggleEcoIndicator,
    isNormalClockEnabled, toggleNormalClock,
    isNormalBatteryEnabled, toggleNormalBattery,
    isNormalIndicatorEnabled, toggleNormalIndicator,
    isProMode, toggleProMode, 
    isColorIndicator, toggleColorIndicator,
    isCountdownEnabled, toggleCountdownEnabled,
    countdownSeconds, saveCountdownSeconds,
    hasSeenEcoExplanation, markEcoExplanationSeen
  } = useContext(AppContext);

  const [ecoModalVisible, setEcoModalVisible] = useState(false);

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

  return (
    <ScrollView 
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
          <Text style={[styles.settingText, { color: textColor }]}>└ 時計を表示</Text>
          <Switch
            value={isNormalClockEnabled}
            onValueChange={toggleNormalClock}
            trackColor={{ false: '#333', true: '#34C759' }}
            style={{ transform: [{ scaleX: 0.8 }, { scaleY: 0.8 }] }}
          />
        </View>

        <View style={[styles.settingRowInCard, { borderBottomWidth: 1, borderBottomColor: innerBorderColor }]}>
          <Text style={[styles.settingText, { color: textColor }]}>└ 電池残量を表示</Text>
          <Switch
            value={isNormalBatteryEnabled}
            onValueChange={toggleNormalBattery}
            trackColor={{ false: '#333', true: '#34C759' }}
            style={{ transform: [{ scaleX: 0.8 }, { scaleY: 0.8 }] }}
          />
        </View>

        <View style={[styles.settingRowInCard, { borderBottomWidth: 0 }]}>
          <Text style={[styles.settingText, { color: textColor }]}>└ タイマーリングを表示</Text>
          <Switch
            value={isNormalIndicatorEnabled}
            onValueChange={toggleNormalIndicator}
            trackColor={{ false: '#333', true: '#34C759' }}
            style={{ transform: [{ scaleX: 0.8 }, { scaleY: 0.8 }] }}
          />
        </View>
      </View>

      {/* 3. その他設定グループカード */}
      <Text style={[styles.sectionTitle, { color: sectionHeaderColor }]}>機能・表示設定</Text>
      <View style={[styles.groupCard, { backgroundColor: cardBgColor, borderColor: cardBorderColor }]}>
        <View style={[styles.settingRowInCard, { borderBottomWidth: 1, borderBottomColor: innerBorderColor }]}>
          <Text style={[styles.settingText, { color: textColor }]}>Proモード（広告非表示デモ）</Text>
          <Switch
            value={isProMode}
            onValueChange={toggleProMode}
          />
        </View>

        <View style={[styles.settingRowInCard, { borderBottomWidth: 0 }]}>
          <View style={styles.settingTextContainer}>
            <Text style={[styles.settingText, { color: textColor }]}>カラーインジケーター</Text>
            <Text style={[styles.settingDescription, { color: subTextColor }]}>10分以下のタイマーでリングの色が残量に応じて青→黄→赤に変化します</Text>
          </View>
          <Switch
            value={isColorIndicator}
            onValueChange={toggleColorIndicator}
            trackColor={{ false: '#333', true: '#34C759' }}
          />
        </View>
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
});
