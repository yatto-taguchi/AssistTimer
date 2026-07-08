import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, View, FlatList, TouchableOpacity, Image, Modal, Button } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { getRecords, updateRecordPhoto } from '../utils/recordStorage';

export default function RecordsScreen() {
  const [records, setRecords] = useState([]);
  const [selectedRecord, setSelectedRecord] = useState(null);
  const [modalVisible, setModalVisible] = useState(false);

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
      mediaTypes: ['images'],
      allowsEditing: true,
      quality: 0.8,
    });

    if (!pickerResult.canceled) {
      // 写真を更新
      const newUri = pickerResult.assets[0].uri;
      const updated = await updateRecordPhoto(recordId, newUri);
      setRecords(updated);
      // 開いているモーダル等の情報も更新
      if (selectedRecord && selectedRecord.id === recordId) {
          setSelectedRecord({ ...selectedRecord, photoUri: newUri });
      }
    }
  };

  // タイル（個別の記録行）の描画
  const renderItem = ({ item }) => {
    const dateStr = new Date(item.date).toLocaleDateString();
    return (
      <TouchableOpacity 
        style={styles.recordTile} 
        onPress={() => {
          setSelectedRecord(item);
          setModalVisible(true);
        }}
      >
        {item.photoUri ? (
          <Image source={{ uri: item.photoUri }} style={styles.tileImage} />
        ) : (
          <View style={[styles.tileImage, styles.placeholderImage]}>
             <Text style={styles.placeholderText}>NO PHOTO</Text>
          </View>
        )}
        <View style={styles.tileInfo}>
          <Text style={styles.tileDate}>{dateStr}</Text>
          <Text style={styles.tileCategory}>{item.category || 'カテゴリ未設定'}</Text>
          <Text style={styles.tileDuration}>タイム: {formatDuration(item.duration)}</Text>
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
    <View style={styles.container}>
      {records.length === 0 ? (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyText}>まだ記録がありません。タイマーから練習を記録しましょう！</Text>
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
        <View style={styles.modalContainer}>
          <Text style={styles.modalTitle}>練習の記録詳細</Text>
          
          {selectedRecord && (
            <>
              {selectedRecord.photoUri ? (
                <Image source={{ uri: selectedRecord.photoUri }} style={styles.modalDetailImage} />
              ) : (
                <View style={[styles.modalDetailImage, styles.placeholderImage]}>
                  <Text style={styles.placeholderText}>No Photo Available</Text>
                </View>
              )}
              
              <View style={styles.modalInfoBox}>
                <Text style={styles.infoText}>日付: {new Date(selectedRecord.date).toLocaleString()}</Text>
                <Text style={styles.infoText}>ジャンル: {selectedRecord.category || 'なし'}</Text>
                <Text style={styles.infoText}>かかった時間: {formatDuration(selectedRecord.duration)}</Text>
              </View>

              <View style={styles.modalActionButtons}>
                <TouchableOpacity style={styles.actionButton} onPress={() => handleChangePhoto(selectedRecord.id)}>
                   <Text style={styles.actionButtonText}>写真を変更する</Text>
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
        </View>
      </Modal>

    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F2F2F7',
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
    color: '#8E8E93',
    textAlign: 'center',
    marginBottom: 20,
  },
  recordTile: {
    flexDirection: 'row',
    backgroundColor: '#fff',
    borderRadius: 12,
    marginBottom: 10,
    padding: 10,
    shadowColor: '#000',
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
    color: '#8E8E93',
    marginBottom: 4,
  },
  tileCategory: {
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  tileDuration: {
    fontSize: 16,
    color: '#333',
  },
  // 以下 Modal用のスタイル
  modalContainer: {
    flex: 1,
    backgroundColor: '#fff',
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
    backgroundColor: '#F2F2F7',
    padding: 15,
    borderRadius: 12,
    marginBottom: 30,
  },
  infoText: {
    fontSize: 18,
    marginBottom: 10,
    color: '#333',
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
