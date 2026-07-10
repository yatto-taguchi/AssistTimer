import React, { useContext, useState } from 'react';
import { StyleSheet, Text, View, Switch, TouchableOpacity, Modal, TextInput, KeyboardAvoidingView, Platform, ScrollView } from 'react-native';
import { AppContext } from '../utils/AppContext';

export default function SettingsScreen() {
  const { 
    isEcoMode, toggleEcoMode, 
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

  return (
    <View style={styles.container}>
      <Text style={styles.title}>設定</Text>
      
      <View style={styles.settingRow}>
        <Text style={styles.settingText}>エコモード（省電力・黒背景）</Text>
        <Switch
          value={isEcoMode}
          onValueChange={toggleEcoMode}
        />
      </View>

      <View style={styles.settingRow}>
        <Text style={styles.settingText}>Proモード（広告非表示デモ）</Text>
        <Switch
          value={isProMode}
          onValueChange={toggleProMode}
        />
      </View>

      <View style={styles.settingRow}>
        <View style={styles.settingTextContainer}>
          <Text style={styles.settingText}>カラーインジケーター</Text>
          <Text style={styles.settingDescription}>10分以下のタイマーでリングの色が残量に応じて青→黄→赤に変化します</Text>
        </View>
        <Switch
          value={isColorIndicator}
          onValueChange={toggleColorIndicator}
          trackColor={{ false: '#D1D1D6', true: '#34C759' }}
        />
      </View>

      <View style={styles.settingRow}>
        <View style={styles.settingTextContainer}>
          <Text style={styles.settingText}>スタート前カウントダウン</Text>
          <Text style={styles.settingDescription}>タイマー開始前に準備時間を設けます</Text>
        </View>
        <Switch
          value={isCountdownEnabled}
          onValueChange={toggleCountdownEnabled}
          trackColor={{ false: '#D1D1D6', true: '#34C759' }}
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
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>準備時間の設定</Text>
            
            <Text style={styles.modalLabel}>直接入力 (秒)</Text>
            <TextInput 
              style={styles.input}
              keyboardType="number-pad"
              value={inputValue}
              onChangeText={setInputValue}
              returnKeyType="done"
              onSubmitEditing={handleSaveModal}
            />

            <Text style={styles.modalLabel}>クイック選択</Text>
            <View style={styles.tilesContainer}>
              {[5, 10, 30, 60].map((sec) => (
                <TouchableOpacity 
                  key={sec} 
                  style={[styles.tile, countdownSeconds === sec && styles.activeTile]} 
                  onPress={() => handleTilePress(sec)}
                >
                  <Text style={[styles.tileText, countdownSeconds === sec && styles.activeTileText]}>{sec}秒</Text>
                </TouchableOpacity>
              ))}
            </View>

            <TouchableOpacity style={styles.saveButton} onPress={handleSaveModal}>
              <Text style={styles.saveButtonText}>決定</Text>
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
    backgroundColor: '#fff',
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
    borderBottomColor: '#E5E5EA',
  },
  settingText: {
    fontSize: 18,
  },
  settingTextContainer: {
    flex: 1,
    marginRight: 10,
  },
  settingDescription: {
    fontSize: 13,
    color: '#8E8E93',
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
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  modalContent: {
    backgroundColor: '#fff',
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
    color: '#333',
  },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
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
    backgroundColor: '#F2F2F7',
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
    color: '#000',
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
