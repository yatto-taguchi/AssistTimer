import React, { useState, useEffect, useRef, useContext } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, Modal, TextInput, Alert, ScrollView } from 'react-native';
// 必要なモジュールのインポート
import { Audio } from 'expo-av';
import * as ImagePicker from 'expo-image-picker';
import RingProgress from '../components/RingProgress';
import { AppContext } from '../utils/AppContext';
import { saveRecord } from '../utils/recordStorage';

export default function HomeScreen() {
  const DEFAULT_SECONDS = 180; // モック: 3分のテスト用
  const [targetTime, setTargetTime] = useState(DEFAULT_SECONDS);
  const [remainingTime, setRemainingTime] = useState(DEFAULT_SECONDS);
  const [isRunning, setIsRunning] = useState(false);
  const [isCountUp, setIsCountUp] = useState(false);
  const [sound, setSound] = useState(null);

  // 記録・保存用State
  const [saveModalVisible, setSaveModalVisible] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState('');
  const [photoUri, setPhotoUri] = useState(null);

  // 時間設定モーダル用State
  const [timeModalVisible, setTimeModalVisible] = useState(false);
  const [manualInputStr, setManualInputStr] = useState('');
  const PRESET_TIMES = [1, 3, 5, 10, 15, 20, 30, 60, 90];

  const { isEcoMode, isProMode, isColorIndicator, isCountdownEnabled, countdownSeconds } = useContext(AppContext);
  
  // スタート前カウントダウン用State
  const [isPreCountingDown, setIsPreCountingDown] = useState(false);
  const [preCountdownTime, setPreCountdownTime] = useState(0);

  const timerRef = useRef(null);

  // 音声のロードと再生用関数
  const playAlarm = async () => {
    try {
      console.log('Play Alarm trigger: 0 seconds reached');
      // const { sound } = await Audio.Sound.createAsync(require('../../assets/alarm.mp3'));
      // setSound(sound);
      // await sound.playAsync();
    } catch (e) {
      console.log("Audio play error", e);
    }
  };

  useEffect(() => {
    return sound ? () => sound.unloadAsync() : undefined;
  }, [sound]);

  // 準備カウントダウン進行のロジック
  useEffect(() => {
    let interval;
    if (isPreCountingDown) {
      interval = setInterval(() => {
        setPreCountdownTime(prev => {
          if (prev <= 1) {
            clearInterval(interval);
            setIsPreCountingDown(false);
            setIsRunning(true); // カウントダウン終了後、メインタイマー開始
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [isPreCountingDown]);

  // メインタイマー進行のロジック
  useEffect(() => {
    if (isRunning) {
      timerRef.current = setInterval(() => {
        setRemainingTime(prev => {
          if (prev <= 1 && !isCountUp) {
            setIsCountUp(true);
            playAlarm();
            return 0; // 次の瞬間に+1で 1 になる
          }
          return isCountUp ? prev + 1 : prev - 1;
        });
      }, 1000);
    } else if (!isRunning && timerRef.current) {
      clearInterval(timerRef.current);
    }
    return () => clearInterval(timerRef.current);
  }, [isRunning, isCountUp]);

  const formatTime = (timeInSeconds) => {
    const isNegative = timeInSeconds < 0;
    const absTime = Math.abs(timeInSeconds);
    const h = Math.floor(absTime / 3600);
    const m = Math.floor((absTime % 3600) / 60);
    const s = absTime % 60;
    
    let formatted;
    if (h > 0) {
      // 1時間以上の場合： h:mm:ss （時は0埋めなし、分と秒は2桁）
      formatted = `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    } else {
      // 1時間未満の場合： m:ss （分は0埋めなし、秒は2桁）
      formatted = `${m}:${s.toString().padStart(2, '0')}`;
    }
    
    return isNegative ? `-${formatted}` : formatted;
  };

  const toggleTimer = () => {
    if (!isRunning && !isPreCountingDown && remainingTime === targetTime && isCountdownEnabled && countdownSeconds > 0) {
      // 初期状態からのスタートでカウントダウン有効の場合、準備カウントダウンを開始
      setPreCountdownTime(countdownSeconds);
      setIsPreCountingDown(true);
    } else {
      if (isPreCountingDown) {
        // カウントダウン中ならキャンセル
        setIsPreCountingDown(false);
      } else {
        // 通常のタイマートグル
        setIsRunning(!isRunning);
      }
    }
  };

  const resetTimer = () => {
    setIsRunning(false);
    setIsPreCountingDown(false);
    setIsCountUp(false);
    setRemainingTime(targetTime);
  };

  // ---- 時間設定機能 ----
  const handleOpenTimeModal = () => {
    if (isRunning || isPreCountingDown) return;
    setManualInputStr(Math.floor(targetTime / 60).toString());
    setTimeModalVisible(true);
  };

  const applyTime = (minutes) => {
    const secs = Math.max(1, Math.floor(minutes * 60));
    setTargetTime(secs);
    setRemainingTime(secs);
    setIsCountUp(false);
    setTimeModalVisible(false);
  };

  const handleManualApply = () => {
    const min = parseFloat(manualInputStr);
    if (!isNaN(min) && min > 0) {
      applyTime(min);
    } else {
      Alert.alert("エラー", "有効な分数を入力してください。");
    }
  };

  // ---- 記録・保存機能 ----
  const handleOpenSaveModal = () => {
    setIsRunning(false); // タイマーを止める
    setIsPreCountingDown(false);
    setSaveModalVisible(true);
  };

  const handleTakePhoto = async () => {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('カメラの許可', '設定からカメラへのアクセスを許可してください。');
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      allowsEditing: true,
      quality: 0.8,
    });
    if (!result.canceled) {
      setPhotoUri(result.assets[0].uri);
    }
  };

  const handlePickPhoto = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('写真の許可', '設定から写真へのアクセスを許可してください。');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      allowsEditing: true,
      quality: 0.8,
    });
    if (!result.canceled) {
      setPhotoUri(result.assets[0].uri);
    }
  };

  const handleSaveRecord = async () => {
    // 経過秒数の計算
    const duration = isCountUp ? targetTime + remainingTime : targetTime - remainingTime;
    
    // 30分オーバー時の確認ダイアログ実装は別途必要な場合に入れる
    // if (duration > 1800) { alert("30分以上経過しています"); }
    
    await saveRecord({
      duration: duration,
      category: selectedCategory || '未分類',
      photoUri: photoUri,
    });
    
    Alert.alert("保存完了", "練習記録を保存しました！");
    
    // モーダルを閉じ、タイマーをリセットする
    setSaveModalVisible(false);
    setSelectedCategory('');
    setPhotoUri(null);
    resetTimer();
  };

  const progress = isCountUp ? 0 : Math.max(0, remainingTime / targetTime);

  // カラーインジケーターのロジック
  let ringColor = '#007AFF'; // デフォルト: ブルー
  let activeProgress = progress;

  if (isPreCountingDown) {
    // 準備カウントダウン中はMAXブルー固定
    activeProgress = 1;
    ringColor = '#007AFF';
  } else if (!isCountUp) {
    if (isColorIndicator && targetTime <= 600) {
      // 残量パーセントに基づく色変更
      const remainingPercent = targetTime > 0 ? remainingTime / targetTime : 0;
      if (remainingPercent <= 0.10) {
        ringColor = '#FF3B30'; // レッド（残り10%以下）
      } else if (remainingPercent <= 0.30) {
        ringColor = '#FFCC00'; // イエロー（残り30%以下）
      } else {
        ringColor = '#007AFF'; // ブルー（残り30%超）
      }
    } else {
      // 従来のロジック（固定秒数ベース）
      if (remainingTime <= 60) ringColor = '#FF3B30';
      else if (remainingTime <= 300) ringColor = '#FFCC00';
    }
  } else {
    ringColor = '#FF3B30';
  }

  // エコモードによるテーマ設定
  const bgColor = isEcoMode ? '#000' : '#F5F5F5';
  const mainTextColor = isEcoMode ? '#fff' : '#000';
  const ringBgColor = isEcoMode ? '#333' : '#E5E5EA';

  return (
    <View style={[styles.container, { backgroundColor: bgColor }]}>
      <View style={styles.content}>
        <View style={styles.timerContainer}>
          <RingProgress 
            radius={140} 
            strokeWidth={15} 
            progress={activeProgress} 
            color={ringColor}
            backgroundColor={ringBgColor}
            fillColor="transparent"
          />
          <View style={styles.timeTextContainer}>
            {isPreCountingDown ? (
              <Text style={[styles.preCountdownText, { color: mainTextColor }]}>
                {preCountdownTime}
              </Text>
            ) : (
              <TouchableOpacity onPress={handleOpenTimeModal} disabled={isRunning}>
                <Text style={[styles.timeText, { color: isCountUp ? '#FF3B30' : mainTextColor }]}>
                  {isCountUp ? '+' : ''}{formatTime(remainingTime)}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        </View>

        <View style={styles.controlsContainer}>
          <TouchableOpacity style={styles.button} onPress={toggleTimer}>
            <Text style={styles.buttonText}>{isRunning || isPreCountingDown ? '一時停止' : 'スタート'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.button, styles.resetButton]} onPress={resetTimer}>
            <Text style={[styles.buttonText, { color: '#000' }]}>リセット</Text>
          </TouchableOpacity>
        </View>
        
        {/* 記録ボタンは一時停止中か、タイマー進行中に表示 */}
        {(!isRunning && !isPreCountingDown && remainingTime !== targetTime) || isCountUp ? (
          <TouchableOpacity style={styles.saveActionButton} onPress={handleOpenSaveModal}>
            <Text style={styles.saveActionText}>記録・保存する</Text>
          </TouchableOpacity>
        ) : null}

      </View>

      {/* 広告バナー（デモ） */}
      {!isProMode && (
        <View style={styles.adBanner}>
          <Text style={styles.adText}>Demo Ad Banner</Text>
        </View>
      )}

      {/* 記録保存用モーダル */}
      <Modal visible={saveModalVisible} animationType="slide">
        <ScrollView contentContainerStyle={styles.modalContainer}>
          <Text style={styles.modalTitle}>練習結果の記録</Text>
          
          <Text style={styles.label}>ジャンル（任意）</Text>
          <TextInput 
            style={styles.input} 
            placeholder="例: カット、カラー、など"
            value={selectedCategory}
            onChangeText={setSelectedCategory}
          />
          
          <Text style={styles.label}>写真を追加</Text>
          <View style={styles.photoActionBox}>
             <TouchableOpacity style={styles.photoButton} onPress={handleTakePhoto}>
               <Text style={styles.photoButtonText}>カメラで撮影</Text>
             </TouchableOpacity>
             <TouchableOpacity style={styles.photoButton} onPress={handlePickPhoto}>
               <Text style={styles.photoButtonText}>ギャラリーから選択</Text>
             </TouchableOpacity>
          </View>

          {photoUri && (
            <Text style={{color: 'green', marginVertical: 10, textAlign: 'center'}}>✓ 写真が選択されました</Text>
          )}

          <TouchableOpacity style={[styles.saveActionButton, {marginTop: 40}]} onPress={handleSaveRecord}>
             <Text style={styles.saveActionText}>記録を保存してリセット</Text>
          </TouchableOpacity>

          <TouchableOpacity style={[styles.resetButton, {marginTop: 20, padding: 15, borderRadius: 10}]} onPress={() => setSaveModalVisible(false)}>
             <Text style={{textAlign: 'center', color: '#000', fontWeight: 'bold'}}>キャンセル</Text>
          </TouchableOpacity>
        </ScrollView>
      </Modal>

      {/* タイマー時間設定モーダル */}
      <Modal visible={timeModalVisible} animationType="fade" transparent={true}>
        <View style={styles.timeModalOverlay}>
          <View style={[styles.timeModalContent, { backgroundColor: isEcoMode ? '#222' : '#fff' }]}>
            <Text style={[styles.timeModalTitle, { color: isEcoMode ? '#fff' : '#000' }]}>タイマー時間の設定</Text>
            
            {/* 任意入力エリア */}
            <View style={styles.manualInputContainer}>
              <TextInput
                style={[styles.timeInput, { color: isEcoMode ? '#fff' : '#000', borderColor: isEcoMode ? '#555' : '#ccc' }]}
                keyboardType="numeric"
                value={manualInputStr}
                onChangeText={setManualInputStr}
                placeholder="分数"
                placeholderTextColor="#888"
              />
              <Text style={[styles.timeInputLabel, { color: isEcoMode ? '#fff' : '#000' }]}>分</Text>
              <TouchableOpacity style={styles.applyButton} onPress={handleManualApply}>
                <Text style={styles.applyButtonText}>設定</Text>
              </TouchableOpacity>
            </View>

            {/* 9つのタイルエリア */}
            <View style={styles.presetTilesContainer}>
              {PRESET_TIMES.map((m) => (
                <TouchableOpacity 
                  key={m} 
                  style={[styles.presetTile, { backgroundColor: isEcoMode ? '#333' : '#F0F0F0' }]} 
                  onPress={() => applyTime(m)}
                >
                  <Text style={[styles.presetTileText, { color: isEcoMode ? '#fff' : '#000' }]}>{m}分</Text>
                </TouchableOpacity>
              ))}
            </View>

            <TouchableOpacity style={styles.closeTimeModalButton} onPress={() => setTimeModalVisible(false)}>
              <Text style={styles.closeTimeModalText}>キャンセル</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  timerContainer: {
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 60,
  },
  timeTextContainer: {
    position: 'absolute',
    justifyContent: 'center',
    alignItems: 'center',
  },
  timeText: {
    fontSize: 48,
    fontWeight: '500',
    fontVariant: ['tabular-nums'], // 数字の幅を等間隔にして揺れを防止
  },
  preCountdownText: {
    fontSize: 120, // 枠いっぱいの大きなサイズ
    fontWeight: 'bold',
    fontVariant: ['tabular-nums'], // こちらも揺れを防止
  },
  controlsContainer: {
    flexDirection: 'row',
    gap: 20,
    marginBottom: 30, // saveボタンなどの余白
  },
  button: {
    backgroundColor: '#007AFF', // ブルー
    paddingVertical: 15,
    paddingHorizontal: 30,
    borderRadius: 30,
  },
  resetButton: {
    backgroundColor: '#E5E5EA',
  },
  buttonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
  },
  saveActionButton: {
    backgroundColor: '#34C759', // グリーン
    paddingVertical: 15,
    paddingHorizontal: 40,
    borderRadius: 30,
  },
  saveActionText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: 'bold',
    textAlign: 'center',
  },
  adBanner: {
    height: 50,
    backgroundColor: '#D1D1D6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  adText: {
    color: '#333',
    fontWeight: 'bold',
    fontSize: 16,
  },
  // モーダル用
  modalContainer: {
    padding: 30,
    marginTop: 50,
    backgroundColor: '#fff',
  },
  modalTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 30,
    textAlign: 'center',
  },
  label: {
    fontSize: 16,
    fontWeight: '600',
    marginTop: 20,
    marginBottom: 10,
  },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    padding: 15,
    borderRadius: 8,
    fontSize: 16,
  },
  photoActionBox: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 10,
  },
  photoButton: {
    flex: 1,
    backgroundColor: '#007AFF',
    padding: 15,
    borderRadius: 8,
    alignItems: 'center',
  },
  photoButtonText: {
    color: '#fff',
    fontWeight: '600',
  },
  // 時間設定モーダル用スタイル
  timeModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  timeModalContent: {
    width: '90%',
    borderRadius: 15,
    padding: 20,
    alignItems: 'center',
    maxWidth: 400,
  },
  timeModalTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    marginBottom: 20,
  },
  manualInputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 25,
    justifyContent: 'center',
  },
  timeInput: {
    borderWidth: 1,
    borderRadius: 8,
    width: 80,
    height: 45,
    textAlign: 'center',
    fontSize: 20,
  },
  timeInputLabel: {
    fontSize: 18,
    marginHorizontal: 10,
    fontWeight: 'bold',
  },
  applyButton: {
    backgroundColor: '#007AFF',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 8,
  },
  applyButtonText: {
    color: '#fff',
    fontWeight: 'bold',
    fontSize: 16,
  },
  presetTilesContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: 10,
    marginBottom: 10,
  },
  presetTile: {
    width: '30%',
    aspectRatio: 2,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 10,
    marginBottom: 10,
  },
  presetTileText: {
    fontSize: 18,
    fontWeight: 'bold',
  },
  closeTimeModalButton: {
    marginTop: 15,
    padding: 10,
  },
  closeTimeModalText: {
    fontSize: 16,
    color: '#007AFF',
    fontWeight: 'bold',
  },
});
