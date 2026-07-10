import React, { useContext, useState } from 'react';
import { StyleSheet, Text, View, Switch, TouchableOpacity, Modal, TextInput, KeyboardAvoidingView, Platform, ScrollView } from 'react-native';
import { AppContext } from '../utils/AppContext';

export default function SettingsScreen() {
  const { 
    isEcoMode, toggleEcoMode, 
    isEcoClockEnabled, toggleEcoClock,
    isEcoBatteryEnabled, toggleEcoBattery,
    isEcoNavIconEnabled, toggleEcoNavIcon,
    isEcoNavActiveDot, toggleEcoNavActiveDot,
    isEcoBorderEnabled, toggleEcoBorder,
    isProMode, toggleProMode, 
    isColorIndicator, toggleColorIndicator,
    isCountdownEnabled, toggleCountdownEnabled,
    countdownSeconds, saveCountdownSeconds
  } = useContext(AppContext);

  const [modalVisible, setModalVisible] = useState(false);
  const [inputValue, setInputValue] = useState(countdownSeconds.toString());

  const handleOpenModal = () => {
    setInputValue(countdownSeconds.toString());
    setModalVisible(true);
  };

  const handleSaveModal = () => {
    const parsed = parseInt(inputValue, 10);
    if (!isNaN(parsed) && parsed > 0) {
      saveCountdownSeconds(parsed);
      setModalVisible(false);
    } else {
      setInputValue(countdownSeconds.toString());
      setModalVisible(false);
    }
  };

  const handleTilePress = (secs) => {
    saveCountdownSeconds(secs);
    setModalVisible(false);
  };

  const bgColor = isEcoMode ? '#000' : '#F5F5F5';
  const textColor = isEcoMode ? '#fff' : '#000';
  const subTextColor = isEcoMode ? '#aaa' : '#8E8E93';
  const borderColor = isEcoMode ? '#333' : '#E5E5EA';

  return (
    <View style={[styles.container, { backgroundColor: bgColor }]}>
      <Text style={[styles.title, { color: textColor }]}>設定</Text>
      
      <View style={[styles.settingRow, { borderBottomColor: borderColor }]}>
        <Text style={[styles.settingText, { color: textColor }]}>エコモード（極限省電力）</Text>
        <Switch
          value={isEcoMode}
          onValueChange={toggleEcoMode}
        />
      </View>

      {isEcoMode && (
        <View style={styles.subSettingsContainer}>
          <View style={[styles.subSettingRow, { borderBottomColor: borderColor }]}>
            <Text style={[styles.subSettingText, { color: textColor }]}>  └ 時計を表示</Text>
            <Switch
              value={isEcoClockEnabled}
              onValueChange={toggleEcoClock}
              trackColor={{ false: '#333', true: '#34C759' }}
              style={{ transform: [{ scaleX: 0.8 }, { scaleY: 0.8 }] }} // 小さくしてサブ設定感を出す
            />
          </View>
          <View style={[styles.subSettingRow, { borderBottomColor: borderColor }]}>
            <Text style={[styles.subSettingText, { color: textColor }]}>  └ 電池残量を表示</Text>
            <Switch
              value={isEcoBatteryEnabled}
              onValueChange={toggleEcoBattery}
              trackColor={{ false: '#333', true: '#34C759' }}
              style={{ transform: [{ scaleX: 0.8 }, { scaleY: 0.8 }] }}
            />
          </View>
          <View style={[styles.subSettingRow, { borderBottomColor: borderColor }]}>
            <Text style={[styles.subSettingText, { color: textColor }]}>  └ タブをアイコンで表示（オフで点）</Text>
            <Switch
              value={isEcoNavIconEnabled}
              onValueChange={toggleEcoNavIcon}
              trackColor={{ false: '#333', true: '#34C759' }}
              style={{ transform: [{ scaleX: 0.8 }, { scaleY: 0.8 }] }}
            />
          </View>
          {!isEcoNavIconEnabled && (
            <View style={[styles.subSettingRow, { borderBottomColor: borderColor, paddingLeft: 20 }]}>
              <Text style={[styles.subSettingText, { color: textColor }]}>    └ 選択中のタブだけ表示する</Text>
              <Switch
                value={isEcoNavActiveDot}
                onValueChange={toggleEcoNavActiveDot}
                trackColor={{ false: '#333', true: '#34C759' }}
                style={{ transform: [{ scaleX: 0.7 }, { scaleY: 0.7 }] }}
              />
            </View>
          )}
          <View style={[styles.subSettingRow, { borderBottomColor: borderColor }]}>
            <Text style={[styles.subSettingText, { color: textColor }]}>  └ タブの境界線を表示</Text>
            <Switch
              value={isEcoBorderEnabled}
              onValueChange={toggleEcoBorder}
              trackColor={{ false: '#333', true: '#34C759' }}
              style={{ transform: [{ scaleX: 0.8 }, { scaleY: 0.8 }] }}
            />
          </View>
        </View>
      )}

      <View style={[styles.settingRow, { borderBottomColor: borderColor }]}>
        <Text style={[styles.settingText, { color: textColor }]}>Proモード（広告非表示デモ）</Text>
        <Switch
          value={isProMode}
          onValueChange={toggleProMode}
        />
      </View>

      <View style={[styles.settingRow, { borderBottomColor: borderColor }]}>
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

      <View style={[styles.settingRow, { borderBottomColor: borderColor }]}>
        <View style={styles.settingTextContainer}>
          <Text style={[styles.settingText, { color: textColor }]}>スタート前カウントダウン</Text>
          <Text style={[styles.settingDescription, { color: subTextColor }]}>タイマー開始前に準備時間を設けます</Text>
        </View>
        <Switch
          value={isCountdownEnabled}
          onValueChange={toggleCountdownEnabled}
          trackColor={{ false: '#333', true: '#34C759' }}
        />
      </View>

      {isCountdownEnabled && (
        <TouchableOpacity style={styles.configButton} onPress={handleOpenModal}>
          <Text style={styles.configButtonText}>準備時間を設定 (現在: {countdownSeconds}秒)</Text>
        </TouchableOpacity>
      )}

      {/* 設定モーダル */}
      <Modal visible={modalVisible} animationType="slide" transparent={true}>
        <KeyboardAvoidingView 
          style={styles.modalOverlay} 
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <View style={[styles.modalContent, { backgroundColor: isEcoMode ? '#111' : '#fff' }]}>
            <Text style={[styles.modalTitle, { color: isEcoMode ? '#fff' : '#000' }]}>準備時間の設定</Text>
            
            <Text style={[styles.modalLabel, { color: isEcoMode ? '#aaa' : '#333' }]}>直接入力 (秒)</Text>
            <TextInput 
              style={[styles.input, { color: isEcoMode ? '#fff' : '#000', borderColor: isEcoMode ? '#555' : '#ccc' }]}
              keyboardType="number-pad"
              value={inputValue}
              onChangeText={setInputValue}
              returnKeyType="done"
              onSubmitEditing={handleSaveModal}
            />

            <Text style={[styles.modalLabel, { color: isEcoMode ? '#aaa' : '#333' }]}>クイック選択</Text>
            <View style={styles.tilesContainer}>
              {[5, 10, 30, 60].map((sec) => (
                <TouchableOpacity 
                  key={sec} 
                  style={[styles.tile, { backgroundColor: isEcoMode ? '#222' : '#F2F2F7' }, countdownSeconds === sec && styles.activeTile]} 
                  onPress={() => handleTilePress(sec)}
                >
                  <Text style={[styles.tileText, { color: isEcoMode ? '#fff' : '#000' }, countdownSeconds === sec && styles.activeTileText]}>{sec}秒</Text>
                </TouchableOpacity>
              ))}
            </View>

            <TouchableOpacity style={[styles.saveButton, isEcoMode && { backgroundColor: '#333' }]} onPress={handleSaveModal}>
              <Text style={[styles.saveButtonText, isEcoMode && { color: '#fff' }]}>決定</Text>
            </TouchableOpacity>
            
            <TouchableOpacity style={styles.closeButton} onPress={() => setModalVisible(false)}>
              <Text style={styles.closeButtonText}>閉じる</Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>

    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 20,
    justifyContent: 'flex-start',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 30,
    marginTop: 20,
  },
  settingRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 15,
    borderBottomWidth: 1,
  },
  subSettingsContainer: {
    paddingLeft: 10,
  },
  subSettingRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  settingText: {
    fontSize: 18,
  },
  subSettingText: {
    fontSize: 16,
    color: '#8E8E93',
  },
  settingTextContainer: {
    flex: 1,
    marginRight: 10,
  },
  settingDescription: {
    fontSize: 13,
    marginTop: 4,
  },
  configButton: {
    marginTop: 15,
    backgroundColor: '#007AFF',
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  configButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  modalOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.7)',
  },
  modalContent: {
    padding: 25,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    minHeight: 400,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    textAlign: 'center',
    marginBottom: 20,
  },
  modalLabel: {
    fontSize: 16,
    fontWeight: '600',
    marginTop: 15,
    marginBottom: 10,
  },
  input: {
    borderWidth: 1,
    padding: 15,
    borderRadius: 8,
    fontSize: 18,
    textAlign: 'center',
  },
  tilesContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: 10,
    marginTop: 5,
  },
  tile: {
    width: '47%',
    aspectRatio: 2,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 12,
    marginBottom: 10,
  },
  activeTile: {
    backgroundColor: '#007AFF',
  },
  tileText: {
    fontSize: 20,
    fontWeight: '600',
  },
  activeTileText: {
    color: '#fff',
  },
  saveButton: {
    backgroundColor: '#34C759',
    padding: 15,
    borderRadius: 10,
    marginTop: 30,
  },
  saveButtonText: {
    color: '#fff',
    textAlign: 'center',
    fontSize: 18,
    fontWeight: 'bold',
  },
  closeButton: {
    padding: 15,
    marginTop: 10,
  },
  closeButtonText: {
    color: '#007AFF',
    textAlign: 'center',
    fontSize: 16,
  },
});
