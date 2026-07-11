import React, { useState, useEffect, useRef, useContext } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, Modal, TextInput, Alert, ScrollView, Switch, Animated, TouchableWithoutFeedback, Image } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
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
  const [savedCategories, setSavedCategories] = useState(['カット', 'カラー', 'ワインディング', 'アップスタイル']);
  const [lastUsedCategory, setLastUsedCategory] = useState('');
  const [isAddingCategory, setIsAddingCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [photoUris, setPhotoUris] = useState([]);
  const [fullScreenImageUri, setFullScreenImageUri] = useState(null);
  const [forceTargetTime, setForceTargetTime] = useState(false);
  const [selectedTags, setSelectedTags] = useState([]);

  const DEFAULT_TAGS = ['お気に入り', 'タイム'];

  // 時間設定モーダル用State
  const [timeModalVisible, setTimeModalVisible] = useState(false);
  const [timeModalMode, setTimeModalMode] = useState('time'); // 'time' or 'countdown'
  const [manualInputMinStr, setManualInputMinStr] = useState('');
  const [manualInputSecStr, setManualInputSecStr] = useState('');
  const PRESET_TIMES = [1, 3, 5, 10, 15, 20, 30, 60, 90];

  // 準備時間入力用State
  const [countdownInputMinStr, setCountdownInputMinStr] = useState('');
  const [countdownInputSecStr, setCountdownInputSecStr] = useState('');

  const { 
    isEcoMode, isProMode, isColorIndicator, 
    isCountdownEnabled, toggleCountdownEnabled, 
    countdownSeconds, saveCountdownSeconds 
  } = useContext(AppContext);
  
  // スタート前カウントダウン用State
  const [isPreCountingDown, setIsPreCountingDown] = useState(false);
  const [preCountdownTime, setPreCountdownTime] = useState(0);

  const timerRef = useRef(null);

  // UI表示制御用State
  const [controlsVisible, setControlsVisible] = useState(true);
  const controlsOpacity = useRef(new Animated.Value(1)).current;
  const controlsTimeoutRef = useRef(null);

  // 初回起動時のサウンドロード等と再生用関数
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

  // ジャンル履歴のロード
  useEffect(() => {
    const loadCategoryData = async () => {
      try {
        const storedCategories = await AsyncStorage.getItem('savedCategories');
        if (storedCategories) {
          const parsed = JSON.parse(storedCategories);
          // 新しいデフォルトを確実に追加するためマージして重複排除する
          const merged = Array.from(new Set(['カット', 'カラー', 'ワインディング', 'アップスタイル', ...parsed]));
          setSavedCategories(merged);
        }

        const lastCat = await AsyncStorage.getItem('lastUsedCategory');
        if (lastCat) {
          setLastUsedCategory(lastCat);
          // 初期状態としてセット
          setSelectedCategory(lastCat);
        }
      } catch (e) {
        console.error("Failed to load category data", e);
      }
    };
    loadCategoryData();
  }, []);

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
    } else if (m > 0) {
      // 1時間未満・1分以上の場合： m:ss （分は0埋めなし、秒は2桁）
      formatted = `${m}:${s.toString().padStart(2, '0')}`;
    } else {
      // 1分未満の場合： s （分を非表示、秒も0埋めなしでそのまま表示）
      formatted = `${s}`;
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

  // ---- 操作ボタンの自動非表示ロジック ----
  const showControls = () => {
    setControlsVisible(true);
    Animated.timing(controlsOpacity, {
      toValue: 1,
      duration: 200,
      useNativeDriver: true,
    }).start();

    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current);
    }

    if (isRunning || isPreCountingDown) {
      controlsTimeoutRef.current = setTimeout(() => {
        Animated.timing(controlsOpacity, {
          toValue: 0,
          duration: 300,
          useNativeDriver: true,
        }).start(() => setControlsVisible(false));
      }, 3000);
    }
  };

  useEffect(() => {
    if (isRunning || isPreCountingDown) {
      showControls(); // 進行中は3秒後に隠す
    } else {
      // 停止中・準備前は常に表示
      if (controlsTimeoutRef.current) {
        clearTimeout(controlsTimeoutRef.current);
      }
      setControlsVisible(true);
      Animated.timing(controlsOpacity, {
        toValue: 1,
        duration: 200,
        useNativeDriver: true,
      }).start();
    }
    return () => {
      if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
    };
  }, [isRunning, isPreCountingDown]);

  // ---- 時間設定機能 ----
  const handleOpenTimeModal = () => {
    if (isRunning || isPreCountingDown) return;
    const m = Math.floor(targetTime / 60);
    const s = targetTime % 60;
    setManualInputMinStr(m > 0 ? m.toString() : '');
    setManualInputSecStr(s > 0 ? s.toString() : '');
    setTimeModalMode('time');
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
    const min = parseInt(manualInputMinStr, 10) || 0;
    const sec = parseInt(manualInputSecStr, 10) || 0;
    const totalSecs = min * 60 + sec;
    
    if (totalSecs > 0) {
      setTargetTime(totalSecs);
      setRemainingTime(totalSecs);
      setIsCountUp(false);
      setTimeModalVisible(false);
    } else {
      Alert.alert("エラー", "有効な時間を入力してください。");
    }
  };

  // ---- 記録・保存機能 ----
  const handleOpenSaveModal = () => {
    setIsRunning(false); // タイマーを止める
    setIsPreCountingDown(false);
    setForceTargetTime(false);
    setSelectedCategory(lastUsedCategory); // デフォルトで前回のカテゴリをセット
    setSelectedTags([]); // タグを初期化
    setSaveModalVisible(true);
  };

  const handleOpenSaveInTimeModal = () => {
    setIsRunning(false); // タイマーを止める
    setIsPreCountingDown(false);
    setForceTargetTime(true); // 時間内に終わったことにしてターゲットタイムを記録する
    setSelectedCategory(lastUsedCategory); // デフォルトで前回のカテゴリをセット
    setSelectedTags([]); // タグを初期化
    setSaveModalVisible(true);
  };

  const handleTakePhoto = async () => {
    if (photoUris.length >= 4) {
      Alert.alert('制限', '写真は最大4枚までです。');
      return;
    }
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('カメラの許可', '設定からカメラへのアクセスを許可してください。');
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      allowsEditing: false, // 複数対応のために一旦false
      quality: 0.8,
    });
    if (!result.canceled && result.assets && result.assets.length > 0) {
      setPhotoUris([...photoUris, result.assets[0].uri]);
    }
  };

  const handlePickPhoto = async () => {
    if (photoUris.length >= 4) {
      Alert.alert('制限', '写真は最大4枚までです。');
      return;
    }
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('写真の許可', '設定から写真へのアクセスを許可してください。');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      allowsEditing: false,
      allowsMultipleSelection: true,
      selectionLimit: 4 - photoUris.length,
      quality: 0.8,
    });
    if (!result.canceled && result.assets) {
      const newUris = result.assets.map(a => a.uri);
      const combined = [...photoUris, ...newUris].slice(0, 4);
      setPhotoUris(combined);
    }
  };

  const handleSaveRecord = async () => {
    // 経過秒数の計算
    let duration = isCountUp ? targetTime + remainingTime : targetTime - remainingTime;
    
    if (forceTargetTime) {
      duration = targetTime; // タイム内に入って終了した場合はターゲットタイムをそのまま記録
    }
    
    await saveRecord({
      duration: duration,
      category: selectedCategory || '未分類',
      photoUris: photoUris,
      tags: selectedTags,
    });
    
    if (selectedCategory) {
      await AsyncStorage.setItem('lastUsedCategory', selectedCategory);
      setLastUsedCategory(selectedCategory);
    }
    
    Alert.alert("保存完了", "練習記録を保存しました！");
    
    // モーダルを閉じ、タイマーをリセットする
    setSaveModalVisible(false);
    setPhotoUri(null);
    resetTimer();
  };

  const handleAddCategory = async () => {
    if (newCategoryName.trim()) {
      const newCats = [...savedCategories, newCategoryName.trim()];
      const uniqueCats = Array.from(new Set(newCats));
      setSavedCategories(uniqueCats);
      setSelectedCategory(newCategoryName.trim());
      setNewCategoryName('');
      setIsAddingCategory(false);
      try {
        await AsyncStorage.setItem('savedCategories', JSON.stringify(uniqueCats));
      } catch (e) {
        console.error(e);
      }
    }
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
    <TouchableWithoutFeedback onPress={showControls}>
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

        <Animated.View style={[{ opacity: controlsOpacity, width: '100%', alignItems: 'center' }]} pointerEvents={controlsVisible ? 'auto' : 'none'}>
          <View style={styles.controlsContainer}>
            <TouchableOpacity style={styles.button} onPress={toggleTimer} disabled={!controlsVisible}>
              <Text style={styles.buttonText}>{isRunning || isPreCountingDown ? '一時停止' : 'スタート'}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.button, styles.resetButton]} onPress={resetTimer} disabled={!controlsVisible}>
              <Text style={[styles.buttonText, { color: '#000' }]}>リセット</Text>
            </TouchableOpacity>
          </View>
          
          {/* 計測中のみ表示される「計測終了」ボタン群 */}
          {isRunning && (
            <Animated.View style={{ opacity: controlsOpacity, width: '100%', alignItems: 'center' }}>
              {isCountUp ? (
                <View style={styles.splitEndButtonContainer}>
                  <TouchableOpacity 
                    style={[styles.splitEndButtonHalf, { backgroundColor: '#34C759' }]} 
                    onPress={handleOpenSaveInTimeModal}
                  >
                    <Text style={styles.splitEndButtonMainText}>計測終了</Text>
                    <Text style={styles.splitEndButtonSubText}>タイム内</Text>
                  </TouchableOpacity>
                  
                  <View style={styles.splitEndButtonDivider} />

                  <TouchableOpacity 
                    style={[styles.splitEndButtonHalf, { backgroundColor: '#FF3B30' }]} 
                    onPress={handleOpenSaveModal}
                  >
                    <Text style={styles.splitEndButtonMainText}>計測終了</Text>
                    <Text style={styles.splitEndButtonSubText}>タイムオーバー</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <TouchableOpacity style={styles.endMeasurementButton} onPress={handleOpenSaveModal}>
                  <Text style={[styles.buttonText, { fontWeight: 'bold' }]}>計測終了</Text>
                </TouchableOpacity>
              )}
            </Animated.View>
          )}

          {/* 記録ボタンは一時停止中か、カウントアップ中に表示 */}
          {!isRunning && !isPreCountingDown && remainingTime !== targetTime && (
            <TouchableOpacity style={styles.saveActionButton} onPress={handleOpenSaveModal}>
              <Text style={styles.saveActionText}>記録・保存する</Text>
            </TouchableOpacity>
          )}
        </Animated.View>

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

          {/* 計測時間の詳細表示 */}
          <View style={{ backgroundColor: isEcoMode ? '#333' : '#F2F2F7', padding: 15, borderRadius: 10, width: '100%', marginBottom: 20, alignItems: 'center' }}>
            {(() => {
              let actualDuration = isCountUp ? targetTime + remainingTime : targetTime - remainingTime;
              if (forceTargetTime) actualDuration = targetTime;
              
              const isOver = isCountUp && !forceTargetTime;
              const overSeconds = isCountUp && !forceTargetTime ? remainingTime : 0;
              
              const m = Math.floor(actualDuration / 60);
              const s = actualDuration % 60;
              const timeStr = `${m}分${s}秒`;

              if (isOver) {
                const om = Math.floor(overSeconds / 60);
                const os = overSeconds % 60;
                const overStr = `+${om > 0 ? om + '分' : ''}${os}秒`;
                return (
                  <>
                    <Text style={{ fontSize: 18, fontWeight: 'bold', color: '#FF3B30', marginBottom: 5 }}>タイムオーバー</Text>
                    <Text style={{ fontSize: 24, fontWeight: 'bold', color: isEcoMode ? '#fff' : '#000' }}>{timeStr} <Text style={{ fontSize: 16, color: '#FF3B30' }}>({overStr})</Text></Text>
                  </>
                );
              } else {
                return (
                  <>
                    <Text style={{ fontSize: 18, fontWeight: 'bold', color: '#34C759', marginBottom: 5 }}>タイム内</Text>
                    <Text style={{ fontSize: 24, fontWeight: 'bold', color: isEcoMode ? '#fff' : '#000' }}>{timeStr}</Text>
                  </>
                );
              }
            })()}
          </View>

          <Text style={styles.label}>選択中のジャンル</Text>
          <TextInput 
            style={[styles.input, { backgroundColor: '#f0f0f0', color: '#333', marginBottom: 20 }]} 
            placeholder="未選択"
            value={selectedCategory}
            editable={false}
          />

          <Text style={[styles.label, {alignSelf: 'flex-start', color: isEcoMode ? '#aaa' : '#666'}]}>ジャンルを選択</Text>
          <View style={styles.categoryChipsContainer}>
            {/* 選択中のものを先頭に並び替えて表示 */}
            {[...savedCategories].sort((a, b) => a === selectedCategory ? -1 : b === selectedCategory ? 1 : 0).map((cat, index) => (
              <TouchableOpacity 
                key={index}
                style={[styles.categoryChip, selectedCategory === cat && styles.categoryChipSelected]}
                onPress={() => setSelectedCategory(cat)}
              >
                <Text style={[styles.categoryChipText, selectedCategory === cat && styles.categoryChipTextSelected]}>{cat}</Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity 
              style={[styles.categoryChip, styles.categoryChipAdd]}
              onPress={() => setIsAddingCategory(!isAddingCategory)}
            >
              <Text style={styles.categoryChipTextAdd}>＋ 追加</Text>
            </TouchableOpacity>
          </View>

          {isAddingCategory && (
            <View style={styles.addCategoryContainer}>
              <TextInput 
                style={[styles.input, { flex: 1, marginBottom: 0, marginRight: 10 }]} 
                placeholder="新しいジャンル名を入力"
                value={newCategoryName}
                onChangeText={setNewCategoryName}
                onSubmitEditing={handleAddCategory}
              />
              <TouchableOpacity style={styles.addCategoryButton} onPress={handleAddCategory}>
                <Text style={styles.addCategoryButtonText}>決定</Text>
              </TouchableOpacity>
            </View>
          )}
          
          <Text style={styles.label}>写真を追加（最大4枚）</Text>
          <View style={styles.photoActionBox}>
             <TouchableOpacity style={styles.photoButton} onPress={handleTakePhoto}>
               <Text style={styles.photoButtonText}>カメラで撮影</Text>
             </TouchableOpacity>
             <TouchableOpacity style={styles.photoButton} onPress={handlePickPhoto}>
               <Text style={styles.photoButtonText}>ギャラリーから選択</Text>
             </TouchableOpacity>
          </View>

          {photoUris.length > 0 && (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginVertical: 10, justifyContent: 'center' }}>
              {photoUris.map((uri, index) => (
                <View key={`photo-${index}`} style={{ margin: 5 }}>
                  <TouchableOpacity onPress={() => setFullScreenImageUri(uri)}>
                    <Image source={{ uri }} style={{ width: 80, height: 80, borderRadius: 8 }} resizeMode="contain" />
                  </TouchableOpacity>
                  <TouchableOpacity 
                    style={{ position: 'absolute', top: -8, right: -8, backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: 12, width: 24, height: 24, justifyContent: 'center', alignItems: 'center' }}
                    onPress={() => {
                      setPhotoUris(photoUris.filter((_, i) => i !== index));
                    }}
                  >
                    <Text style={{ color: '#fff', fontSize: 14, fontWeight: 'bold' }}>×</Text>
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          )}

          <Text style={[styles.label, { marginTop: 20 }]}>タグをつける</Text>
          <View style={styles.categoryChipsContainer}>
            {DEFAULT_TAGS.map((tag, index) => {
              const isSelected = selectedTags.includes(tag);
              return (
                <TouchableOpacity
                  key={`tag-${index}`}
                  style={[styles.categoryChip, isSelected && styles.categoryChipSelected]}
                  onPress={() => {
                    if (isSelected) {
                      setSelectedTags(selectedTags.filter(t => t !== tag));
                    } else {
                      setSelectedTags([...selectedTags, tag]);
                    }
                  }}
                >
                  <Text style={[styles.categoryChipText, isSelected && styles.categoryChipTextSelected]}>{tag}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <TouchableOpacity style={[styles.saveActionButton, {marginTop: 40}]} onPress={handleSaveRecord}>
             <Text style={styles.saveActionText}>記録を保存してリセット</Text>
          </TouchableOpacity>

          <TouchableOpacity style={[styles.resetButton, {marginTop: 20, padding: 15, borderRadius: 10}]} onPress={() => setSaveModalVisible(false)}>
             <Text style={{textAlign: 'center', color: '#000', fontWeight: 'bold'}}>キャンセル</Text>
          </TouchableOpacity>
        </ScrollView>
      </Modal>

      {/* 写真の全画面プレビュー用モーダル */}
      <Modal visible={!!fullScreenImageUri} transparent={true} animationType="fade">
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.9)', justifyContent: 'center', alignItems: 'center' }}>
          {fullScreenImageUri && (
            <Image source={{ uri: fullScreenImageUri }} style={{ width: '100%', height: '80%' }} resizeMode="contain" />
          )}
          <TouchableOpacity 
            style={{ position: 'absolute', top: 50, right: 20, padding: 10, backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: 20 }}
            onPress={() => setFullScreenImageUri(null)}
          >
            <Text style={{ color: '#fff', fontSize: 18, fontWeight: 'bold' }}>閉じる</Text>
          </TouchableOpacity>
        </View>
      </Modal>

      {/* タイマー・カウントダウン設定モーダル（1つのモーダルで中身を切り替える） */}
      <Modal visible={timeModalVisible} animationType="fade" transparent={true}>
        <View style={styles.timeModalOverlay}>
          <View style={[styles.timeModalContent, { backgroundColor: isEcoMode ? '#222' : '#fff' }]}>
            {timeModalMode === 'time' ? (
              <>
                <Text style={[styles.timeModalTitle, { color: isEcoMode ? '#fff' : '#000' }]}>タイマー時間の設定</Text>
                
                {/* 任意入力エリア */}
                <Text style={[styles.countdownSectionLabel, {marginTop: 0, marginBottom: 10}]}>直接入力</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginBottom: 15 }}>
                  <TextInput 
                    style={[styles.timeInput, { width: 80, color: isEcoMode ? '#fff' : '#000', borderColor: isEcoMode ? '#555' : '#ccc' }]}
                    keyboardType="number-pad"
                    value={manualInputMinStr}
                    onChangeText={setManualInputMinStr}
                    onFocus={() => setManualInputMinStr('')}
                    selectTextOnFocus={true}
                    placeholder="0"
                    placeholderTextColor="#888"
                    returnKeyType="done"
                  />
                  <Text style={{ fontSize: 16, color: isEcoMode ? '#fff' : '#000', marginHorizontal: 10 }}>分</Text>
                  <TextInput 
                    style={[styles.timeInput, { width: 80, color: isEcoMode ? '#fff' : '#000', borderColor: isEcoMode ? '#555' : '#ccc' }]}
                    keyboardType="number-pad"
                    value={manualInputSecStr}
                    onChangeText={setManualInputSecStr}
                    onFocus={() => setManualInputSecStr('')}
                    selectTextOnFocus={true}
                    placeholder="0"
                    placeholderTextColor="#888"
                    returnKeyType="done"
                  />
                  <Text style={{ fontSize: 16, color: isEcoMode ? '#fff' : '#000', marginLeft: 10 }}>秒</Text>
                </View>

                <TouchableOpacity style={[styles.applyButton, { alignSelf: 'center', marginBottom: 20 }]} onPress={handleManualApply}>
                  <Text style={styles.applyButtonText}>設定</Text>
                </TouchableOpacity>

                {/* 9つのタイルエリア */}
                <View style={[styles.presetTilesContainer, { borderBottomWidth: 1, borderBottomColor: isEcoMode ? '#333' : '#E5E5EA', paddingBottom: 20 }]}>
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

                {/* スタート前準備時間設定への導線 */}
                <TouchableOpacity 
                  style={[styles.countdownSettingCard, { backgroundColor: '#007AFF', paddingVertical: 12, marginTop: 0 }]} 
                  onPress={() => {
                    const m = Math.floor(countdownSeconds / 60);
                    const s = countdownSeconds % 60;
                    setCountdownInputMinStr(m > 0 ? m.toString() : '');
                    setCountdownInputSecStr(s > 0 ? s.toString() : '');
                    setTimeModalMode('countdown');
                  }}
                >
                  <Text style={[styles.countdownSettingCardTitle, { color: '#fff', marginBottom: 2 }]}>
                    スタート前カウントダウン
                  </Text>
                  <Text style={[styles.countdownSettingCardStatus, { color: '#E5F1FF', fontSize: 13, fontWeight: 'normal' }]}>
                    ({isCountdownEnabled ? `現在${countdownSeconds}秒` : 'オフ'})
                  </Text>
                </TouchableOpacity>
                <Text style={{textAlign: 'center', fontSize: 13, color: isEcoMode ? '#888' : '#666', marginTop: 8, marginBottom: 5}}>
                  準備時間を設定できます
                </Text>

                <TouchableOpacity style={styles.closeTimeModalButton} onPress={() => setTimeModalVisible(false)}>
                  <Text style={styles.closeTimeModalText}>閉じる</Text>
                </TouchableOpacity>
              </>
            ) : (
              <>
                <Text style={[styles.timeModalTitle, { color: isEcoMode ? '#fff' : '#000' }]}>準備時間の設定</Text>

                <Text style={styles.countdownSectionLabel}>クイック選択</Text>
                <View style={styles.presetTilesContainer}>
                  {['無し', 5, 10, 30, 60, 180].map((sec) => {
                    const isNone = sec === '無し';
                    const isActive = isNone ? !isCountdownEnabled : (isCountdownEnabled && countdownSeconds === sec);
                    const label = isNone ? '無し' : (sec === 180 ? '3分' : `${sec}秒`);
                    return (
                      <TouchableOpacity 
                        key={sec} 
                        style={[styles.presetTile, { width: '31%', backgroundColor: isEcoMode ? '#222' : '#F2F2F7' }, isActive && {backgroundColor: '#007AFF'}]} 
                        onPress={() => {
                          if (isNone) {
                            if (isCountdownEnabled) toggleCountdownEnabled(); // オフにする
                          } else {
                            if (!isCountdownEnabled) toggleCountdownEnabled(); // オンにする
                            saveCountdownSeconds(sec);
                          }
                          setTimeModalMode('time');
                        }}
                      >
                        <Text style={[styles.presetTileText, { fontSize: 16, color: isEcoMode ? '#fff' : '#000' }, isActive && {color: '#fff'}]}>{label}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>

                <Text style={styles.countdownSectionLabel}>直接入力</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginBottom: 10 }}>
                  <TextInput 
                    style={[styles.timeInput, { width: 80, color: isEcoMode ? '#fff' : '#000', borderColor: isEcoMode ? '#555' : '#ccc' }]}
                    keyboardType="number-pad"
                    value={countdownInputMinStr}
                    onChangeText={setCountdownInputMinStr}
                    onFocus={() => setCountdownInputMinStr('')}
                    selectTextOnFocus={true}
                    placeholder="0"
                    placeholderTextColor="#888"
                    returnKeyType="done"
                  />
                  <Text style={{ fontSize: 16, color: isEcoMode ? '#fff' : '#000', marginHorizontal: 10 }}>分</Text>
                  <TextInput 
                    style={[styles.timeInput, { width: 80, color: isEcoMode ? '#fff' : '#000', borderColor: isEcoMode ? '#555' : '#ccc' }]}
                    keyboardType="number-pad"
                    value={countdownInputSecStr}
                    onChangeText={setCountdownInputSecStr}
                    onFocus={() => setCountdownInputSecStr('')}
                    selectTextOnFocus={true}
                    placeholder="0"
                    placeholderTextColor="#888"
                    returnKeyType="done"
                  />
                  <Text style={{ fontSize: 16, color: isEcoMode ? '#fff' : '#000', marginLeft: 10 }}>秒</Text>
                </View>

                <TouchableOpacity style={[styles.applyButton, {marginTop: 10}]} onPress={() => {
                   const m = parseInt(countdownInputMinStr, 10) || 0;
                   const s = parseInt(countdownInputSecStr, 10) || 0;
                   const totalSeconds = (m * 60) + s;
                   if (totalSeconds > 0) {
                     if (!isCountdownEnabled) toggleCountdownEnabled(); // オンにする
                     saveCountdownSeconds(totalSeconds);
                   }
                   setTimeModalMode('time');
                }}>
                  <Text style={styles.applyButtonText}>決定</Text>
                </TouchableOpacity>
                
                <TouchableOpacity style={styles.closeTimeModalButton} onPress={() => setTimeModalMode('time')}>
                  <Text style={styles.closeTimeModalText}>戻る</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </View>
      </Modal>

    </View>
    </TouchableWithoutFeedback>
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
  endMeasurementButton: {
    backgroundColor: '#FF3B30', // 赤色
    paddingVertical: 20,
    paddingHorizontal: 40,
    borderRadius: 10,
    marginTop: 20,
    width: 280, // 上のボタン2つ分と左右の幅を揃える
    alignItems: 'center',
    elevation: 3,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
  },
  splitEndButtonContainer: {
    flexDirection: 'row',
    width: 280,
    marginTop: 20,
    borderRadius: 10,
    overflow: 'hidden',
    elevation: 3,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
  },
  splitEndButtonHalf: {
    flex: 1,
    paddingVertical: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  splitEndButtonDivider: {
    width: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.4)',
  },
  splitEndButtonMainText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },
  splitEndButtonSubText: {
    color: '#fff',
    fontSize: 11,
    marginTop: 2,
    fontWeight: '600',
  },
  endMeasurementText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: 'bold',
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
    borderRadius: 8,
    padding: 12,
    marginBottom: 20,
    fontSize: 16,
  },
  categoryChipsContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginBottom: 5,
  },
  categoryChip: {
    paddingVertical: 8,
    paddingHorizontal: 15,
    backgroundColor: '#E5E5EA',
    borderRadius: 20,
    marginRight: 10,
    marginBottom: 10,
  },
  categoryChipSelected: {
    backgroundColor: '#007AFF',
  },
  categoryChipText: {
    fontSize: 14,
    color: '#333',
  },
  categoryChipTextSelected: {
    color: '#fff',
    fontWeight: 'bold',
  },
  categoryChipAdd: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#007AFF',
  },
  categoryChipTextAdd: {
    color: '#007AFF',
    fontWeight: 'bold',
  },
  addCategoryContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 15,
  },
  addCategoryButton: {
    backgroundColor: '#34C759',
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 8,
  },
  addCategoryButtonText: {
    color: '#fff',
    fontWeight: 'bold',
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
  countdownSettingCard: {
    marginTop: 20,
    paddingVertical: 15,
    paddingHorizontal: 20,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
  },
  countdownSettingCardTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    marginBottom: 6,
  },
  countdownSettingCardSub: {
    fontSize: 14,
    marginBottom: 6,
  },
  countdownSettingCardStatus: {
    fontSize: 14,
    fontWeight: '600',
  },
  countdownSwitchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 20,
  },
  countdownSectionLabel: {
    fontSize: 16,
    fontWeight: '600',
    marginTop: 15,
    marginBottom: 10,
    color: '#888',
  },
});
