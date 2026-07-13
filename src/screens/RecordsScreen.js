import React, { useState, useEffect, useContext } from 'react';
import { StyleSheet, Text, View, FlatList, TouchableOpacity, Image, Modal, Button, ScrollView, Dimensions } from 'react-native';
const { width: screenWidth } = Dimensions.get('window');
import ImageViewer from 'react-native-image-zoom-viewer';
import * as ImagePicker from 'expo-image-picker';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getRecords, updateRecordPhoto } from '../utils/recordStorage';
import { AppContext } from '../utils/AppContext';

export default function RecordsScreen() {
  const [records, setRecords] = useState([]);
  const [selectedRecord, setSelectedRecord] = useState(null);
  const [modalVisible, setModalVisible] = useState(false);
  const [fullScreenIndex, setFullScreenIndex] = useState(null);
  const { isEcoMode } = useContext(AppContext);

  // 画面が表示されるたびにデータを読み込むための簡易フック（ナビゲーションイベントを使うのがベターですが今回は仮）
  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    const data = await getRecords();
    setRecords(data);
  };

  // 画像変更機能
  const handleChangePhoto = async (recordId) => {
    // ギャラリーへのアクセス許可
    const permissionResult = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (permissionResult.granted === false) {
      alert("写真へのアクセス許可が必要です。");
      return;
    }

    const pickerResult = await ImagePicker.launchImageLibraryAsync({
      allowsMultipleSelection: true,
      quality: 0.8,
    });

    if (!pickerResult.canceled) {
      const newUris = pickerResult.assets.map(a => a.uri).slice(0, 4);
      // AsyncStorageの更新
      const stored = await AsyncStorage.getItem('practice_records');
      if (stored) {
        const records = JSON.parse(stored);
        const updated = records.map(r => r.id === recordId ? { ...r, photoUris: newUris, photoUri: newUris[0] } : r);
        await AsyncStorage.setItem('practice_records', JSON.stringify(updated));
        loadData();
      }
      
      // 開いているモーダルの更新
      if (selectedRecord && selectedRecord.id === recordId) {
          setSelectedRecord({ ...selectedRecord, photoUris: newUris, photoUri: newUris[0] });
      }
    }
  };

  // カラー定義
  const bgColor = isEcoMode ? '#000' : '#F2F2F7';
  const tileBgColor = isEcoMode ? '#111' : '#fff';
  const textColor = isEcoMode ? '#fff' : '#333';
  const subTextColor = isEcoMode ? '#888' : '#8E8E93';

  // タイル（個別の記録行）の描画
  const renderItem = ({ item }) => {
    const dateStr = new Date(item.date).toLocaleDateString();
    return (
      <TouchableOpacity 
        style={[styles.recordTile, { backgroundColor: tileBgColor, shadowColor: isEcoMode ? 'transparent' : '#000' }]} 
        onPress={() => {
          setSelectedRecord(item);
          setModalVisible(true);
        }}
      >
        {((item.photoUris && item.photoUris.length > 0) ? item.photoUris[0] : item.photoUri) ? (
          <Image 
            source={{ uri: (item.photoUris && item.photoUris.length > 0) ? item.photoUris[0] : item.photoUri }} 
            style={styles.tileImage} 
            resizeMode="contain"
          />
        ) : (
          <View style={[styles.tileImage, styles.placeholderImage, isEcoMode && { backgroundColor: '#222' }]}>
             <Text style={styles.placeholderText}>NO PHOTO</Text>
          </View>
        )}
        <View style={styles.tileInfo}>
          <Text style={[styles.tileDate, { color: subTextColor }]}>{dateStr}</Text>
          <Text style={[styles.tileCategory, { color: textColor }]}>{item.category || 'カテゴリ未設定'}</Text>
          <Text style={[styles.tileDuration, { color: textColor }]}>タイム: {formatDuration(item.duration)}</Text>
        </View>
      </TouchableOpacity>
    );
  };

  const formatDuration = (sec) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}分${s}秒`;
  };

  return (
    <View style={[styles.container, { backgroundColor: bgColor }]}>
      {records.length === 0 ? (
        <View style={styles.emptyContainer}>
          <Text style={[styles.emptyText, { color: subTextColor }]}>まだ記録がありません。タイマーから練習を記録しましょう！</Text>
          {/* テスト用に再読み込みボタンを置く */}
          <Button title="再読み込み" onPress={loadData} />
        </View>
      ) : (
        <FlatList
          data={records}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={styles.listContainer}
        />
      )}

      {/* 詳細・写真変更用モーダル */}
      <Modal
        visible={modalVisible}
        animationType="slide"
        transparent={false}
      >
        <ScrollView style={[styles.modalContainer, { backgroundColor: bgColor }]}>
          <Text style={[styles.modalTitle, { color: textColor }]}>練習の記録詳細</Text>
          
          {selectedRecord && (
            <>
              {selectedRecord.photoUris && selectedRecord.photoUris.length > 0 ? (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', marginBottom: 15 }}>
                  {selectedRecord.photoUris.map((uri, idx) => (
                    <TouchableOpacity key={idx} onPress={() => setFullScreenIndex(idx)}>
                      <Image source={{ uri }} style={[styles.modalDetailImage, { width: 140, height: 140, margin: 5 }]} />
                    </TouchableOpacity>
                  ))}
                </View>
              ) : selectedRecord.photoUri ? (
                <TouchableOpacity onPress={() => setFullScreenIndex(0)}>
                  <Image source={{ uri: selectedRecord.photoUri }} style={styles.modalDetailImage} />
                </TouchableOpacity>
              ) : (
                <View style={[styles.modalDetailImage, styles.placeholderImage, isEcoMode && { backgroundColor: '#222' }]}>
                  <Text style={styles.placeholderText}>No Photo Available</Text>
                </View>
              )}
              
              <View style={[styles.modalInfoBox, { backgroundColor: tileBgColor }]}>
                <Text style={[styles.infoText, { color: textColor }]}>日付: {new Date(selectedRecord.date).toLocaleString()}</Text>
                <Text style={[styles.infoText, { color: textColor }]}>ジャンル: {selectedRecord.category || 'なし'}</Text>
                <Text style={[styles.infoText, { color: textColor }]}>かかった時間: {formatDuration(selectedRecord.duration)}</Text>
              </View>

              <View style={styles.modalActionButtons}>
                <TouchableOpacity style={[styles.actionButton, isEcoMode && { backgroundColor: '#333' }]} onPress={() => handleChangePhoto(selectedRecord.id)}>
                   <Text style={[styles.actionButtonText, isEcoMode && { color: '#fff' }]}>写真を変更する</Text>
                </TouchableOpacity>
              </View>
            </>
          )}

          <TouchableOpacity 
             style={[styles.actionButton, styles.closeButton]} 
             onPress={() => setModalVisible(false)}
          >
             <Text style={styles.actionButtonText}>閉じる</Text>
          </TouchableOpacity>
        </ScrollView>
        
        {/* 写真の全画面プレビュー用オーバーレイ */}
        {fullScreenIndex !== null && (
          <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'black', zIndex: 1000, elevation: 100 }}>
            <ImageViewer 
              imageUrls={(selectedRecord?.photoUris && selectedRecord.photoUris.length > 0 ? selectedRecord.photoUris : [selectedRecord?.photoUri]).filter(Boolean).map(uri => ({ url: uri }))}
              index={fullScreenIndex}
              onSwipeDown={() => setFullScreenIndex(null)}
              onClick={() => setFullScreenIndex(null)}
              enableSwipeDown={true}
              renderIndicator={() => null}
            />
            <TouchableOpacity 
              style={{ position: 'absolute', top: 50, right: 20, width: 44, height: 44, backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 22, justifyContent: 'center', alignItems: 'center', zIndex: 101 }}
              onPress={() => setFullScreenIndex(null)}
            >
              <Text style={{ color: '#fff', fontSize: 28, fontWeight: 'bold', lineHeight: 32 }}>×</Text>
            </TouchableOpacity>
          </View>
        )}
      </Modal>

    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  listContainer: {
    padding: 10,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  emptyText: {
    fontSize: 16,
    textAlign: 'center',
    marginBottom: 20,
  },
  recordTile: {
    flexDirection: 'row',
    borderRadius: 12,
    marginBottom: 10,
    padding: 10,
    shadowOpacity: 0.1,
    shadowRadius: 5,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  tileImage: {
    width: 80,
    height: 80,
    borderRadius: 8,
    marginRight: 15,
  },
  placeholderImage: {
    backgroundColor: '#E5E5EA',
    justifyContent: 'center',
    alignItems: 'center',
  },
  placeholderText: {
    color: '#8E8E93',
    fontSize: 10,
  },
  tileInfo: {
    flex: 1,
    justifyContent: 'center',
  },
  tileDate: {
    fontSize: 14,
    marginBottom: 4,
  },
  tileCategory: {
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  tileDuration: {
    fontSize: 16,
  },
  // 以下 Modal用のスタイル
  modalContainer: {
    flex: 1,
    padding: 20,
    marginTop: 40,
  },
  modalTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 20,
    textAlign: 'center',
  },
  modalDetailImage: {
    width: '100%',
    height: 300,
    borderRadius: 12,
    marginBottom: 20,
  },
  modalInfoBox: {
    padding: 15,
    borderRadius: 12,
    marginBottom: 30,
  },
  infoText: {
    fontSize: 18,
    marginBottom: 10,
  },
  modalActionButtons: {
    marginBottom: 20,
  },
  actionButton: {
    backgroundColor: '#007AFF',
    padding: 15,
    borderRadius: 10,
    alignItems: 'center',
    marginBottom: 10,
  },
  closeButton: {
    backgroundColor: '#8E8E93',
  },
  actionButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },
});
